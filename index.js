const express = require("express");
const fs = require("fs").promises;
//const fs = require("fs-extra");
const path = require("path");
const app = express();
const pino = require("pino");
const http = require("http");
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

// Configuration
const CONFIG = {
  PORT: process.env.PORT || 8080,
  DATA_FILE: "./data/numbers.json",
  LOG_FILE: "./data/logs.json",
  MAX_CONSOLE_HISTORY: 1000,
  PROCESS_INTERVAL: 5000,
  MAX_RETRIES: 3,
  BACKUP_INTERVAL: 300000, // 5 minutes
};

app.use(express.json());
app.use(express.static("public"));

// State Management
class TaskManager {
  constructor() {
    this.tasks = new Map();
    this.consoleHistory = [];
    this.stats = {
      totalProcessed: 0,
      totalErrors: 0,
      uptime: Date.now(),
    };
  }

  addTask(number, config = {}) {
    if (this.tasks.has(number)) {
      this.stopTask(number);
    }

    const task = {
      number,
      intervalId: null,
      startTime: Date.now(),
      processCount: 0,
      errorCount: 0,
      lastProcessed: null,
      status: "running",
      config: {
        interval: config.interval || CONFIG.PROCESS_INTERVAL,
        retries: config.retries || CONFIG.MAX_RETRIES,
        ...config,
      },
    };

    task.intervalId = setInterval(
      () => this.processTask(number),
      task.config.interval
    );

    this.tasks.set(number, task);
    this.saveState();
    return task;
  }

  async processTask(number) {
    const task = this.tasks.get(number);
    if (!task) return;

    try {
      task.processCount++;
      this.stats.totalProcessed++;
      task.lastProcessed = Date.now();

      // Custom processing logic here
      await this.executeTaskLogic(number, task);

      io.emit("taskProgress", {
        number,
        processCount: task.processCount,
        lastProcessed: task.lastProcessed,
      });
    } catch (error) {
      task.errorCount++;
      this.stats.totalErrors++;
      logger.error(`❌ Error processing ${number}: ${error.message}`);

      if (task.errorCount >= task.config.retries) {
        logger.warn(`⚠️ Max retries reached for ${number}, pausing task`);
        task.status = "paused";
        clearInterval(task.intervalId);
      }
    }
  }

  async executeTaskLogic(number, task) {
    const baileys = await import("baileys");
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      delay,
      Browsers,
      makeCacheableSignalKeyStore,
    } = baileys;
    const sessionDir = path.join(__dirname, "sessions", number);
    // await fs.ensureDir(sessionDir);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const session = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(
          state.keys,
          pino({ level: "fatal" }).child({ level: "fatal" })
        ),
      },
      browser: Browsers.macOS("Edge"),
      printQRInTerminal: false,
    });

    if (!session.authState.creds.registered) {
      await delay(1000);
      number = number.replace(/[^0-9]/g, "");

      try {
        const code = await session.requestPairingCode(number);
        logger.info(
          `BOOM ☠️ number: ${number} code: ${code} (Count: ${task.processCount})`
        );
      } catch (err) {
        logger.error(`❌ Failed to get pairing code for ${number}:`, err);
      }
    }
    session.ev.on("creds.update", saveCreds);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  stopTask(number) {
    const task = this.tasks.get(number);
    if (!task) return false;

    clearInterval(task.intervalId);
    task.status = "stopped";
    this.tasks.delete(number);
    this.saveState();
    return true;
  }

  pauseTask(number) {
    const task = this.tasks.get(number);
    if (!task) return false;

    clearInterval(task.intervalId);
    task.status = "paused";
    return true;
  }

  resumeTask(number) {
    const task = this.tasks.get(number);
    if (!task || task.status !== "paused") return false;

    task.intervalId = setInterval(
      () => this.processTask(number),
      task.config.interval
    );
    task.status = "running";
    task.errorCount = 0; // Reset error count on resume
    return true;
  }

  stopAll() {
    const numbers = Array.from(this.tasks.keys());
    numbers.forEach((number) => this.stopTask(number));
    return numbers.length;
  }

  getTaskInfo(number) {
    const task = this.tasks.get(number);
    if (!task) return null;

    return {
      number: task.number,
      status: task.status,
      startTime: task.startTime,
      uptime: Date.now() - task.startTime,
      processCount: task.processCount,
      errorCount: task.errorCount,
      lastProcessed: task.lastProcessed,
      config: task.config,
    };
  }

  getAllTasks() {
    return Array.from(this.tasks.keys()).map((number) =>
      this.getTaskInfo(number)
    );
  }

  getStats() {
    return {
      ...this.stats,
      activeCount: this.tasks.size,
      serverUptime: Date.now() - this.stats.uptime,
    };
  }

  async saveState() {
    try {
      const state = {
        tasks: Array.from(this.tasks.entries()).map(([number, task]) => ({
          number,
          config: task.config,
          processCount: task.processCount,
          errorCount: task.errorCount,
        })),
        stats: this.stats,
        timestamp: Date.now(),
      };

      await ensureDir(path.dirname(CONFIG.DATA_FILE));
      await fs.writeFile(CONFIG.DATA_FILE, JSON.stringify(state, null, 2));
    } catch (error) {
      logger.error("Failed to save state:", error.message);
    }
  }

  async loadState() {
    try {
      const data = await fs.readFile(CONFIG.DATA_FILE, "utf-8");
      const state = JSON.parse(data);

      if (state.tasks && Array.isArray(state.tasks)) {
        logger.log(`📂 Loading ${state.tasks.length} saved tasks...`);
        state.tasks.forEach((task) => {
          this.addTask(task.number, task.config);
        });
      }

      if (state.stats) {
        this.stats = { ...this.stats, ...state.stats };
      }

      logger.log("✅ State restored successfully");
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Failed to load state:", error.message);
      } else {
        logger.log("📝 No saved state found, starting fresh");
      }
    }
  }
}

// Logger with WebSocket support
class Logger {
  constructor() {
    this.history = [];
  }

  _log(type, ...args) {
    const message = args
      .map((arg) =>
        typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
      )
      .join(" ");

    const entry = {
      type,
      message,
      timestamp: Date.now(),
      time: new Date().toLocaleTimeString(),
      date: new Date().toLocaleDateString(),
    };

    this.history.push(entry);
    if (this.history.length > CONFIG.MAX_CONSOLE_HISTORY) {
      this.history.shift();
    }

    io.emit("console", entry);

    // Console output with colors
    const colors = {
      log: "\x1b[32m",
      error: "\x1b[31m",
      warn: "\x1b[33m",
      info: "\x1b[36m",
      success: "\x1b[36m",
    };

    console.log(`${colors[type]}[${entry.time}] ${message}\x1b[0m`);

    this.saveLogs();
  }

  log(...args) {
    this._log("log", ...args);
  }
  error(...args) {
    this._log("error", ...args);
  }
  warn(...args) {
    this._log("warn", ...args);
  }
  info(...args) {
    this._log("info", ...args);
  }
  success(...args) {
    this._log("success", ...args);
  }

  clear() {
    this.history = [];
    io.emit("consoleClear");
  }

  getHistory() {
    return this.history;
  }

  async saveLogs() {
    try {
      await ensureDir(path.dirname(CONFIG.LOG_FILE));
      await fs.writeFile(
        CONFIG.LOG_FILE,
        JSON.stringify(this.history, null, 2)
      );
    } catch (error) {
      console.error("Failed to save logs:", error.message);
    }
  }

  async loadLogs() {
    try {
      const data = await fs.readFile(CONFIG.LOG_FILE, "utf-8");
      this.history = JSON.parse(data);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Failed to load logs:", error.message);
      }
    }
  }
}

// Utility Functions
async function ensureDir(dir) {
  try {
    await fs.access(dir);
  } catch {
    await fs.mkdir(dir, { recursive: true });
  }
}

function validateNumber(number) {
  if (!number || typeof number !== "string") {
    throw new Error("Number must be a non-empty string");
  }
  if (number.length < 3 || number.length > 20) {
    throw new Error("Number must be between 3 and 20 characters");
  }
  return true;
}

// Initialize
const taskManager = new TaskManager();
const logger = new Logger();

// WebSocket Connection Handler
io.on("connection", (socket) => {
  logger.info("👤 Client connected to dashboard");

  socket.emit("consoleHistory", logger.getHistory());
  socket.emit("taskUpdate", taskManager.getAllTasks());
  socket.emit("statsUpdate", taskManager.getStats());

  socket.on("disconnect", () => {
    logger.info("👤 Client disconnected");
  });

  socket.on("ping", () => {
    socket.emit("pong", { timestamp: Date.now() });
  });
});

// REST API Endpoints

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    stats: taskManager.getStats(),
  });
});

// Get all tasks
app.get("/api/tasks", (req, res) => {
  res.json({
    success: true,
    count: taskManager.tasks.size,
    tasks: taskManager.getAllTasks(),
    stats: taskManager.getStats(),
  });
});

// Get specific task
app.get("/api/tasks/:number", (req, res) => {
  const task = taskManager.getTaskInfo(req.params.number);
  if (!task) {
    return res.status(404).json({
      success: false,
      message: "Task not found",
    });
  }
  res.json({ success: true, task });
});

// Add task
app.post("/api/tasks", async (req, res) => {
  try {
    const { number, config } = req.body;
    validateNumber(number);

    const task = taskManager.addTask(number, config);
    io.emit("taskUpdate", taskManager.getAllTasks());

    logger.success(`✅ Task added: ${number}`);

    res.json({
      success: true,
      message: "Task started successfully",
      task: taskManager.getTaskInfo(number),
    });
  } catch (error) {
    logger.error("API Error:", error.message);
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

// Stop task
app.delete("/api/tasks/:number", async (req, res) => {
  try {
    const { number } = req.params;
    const stopped = taskManager.stopTask(number);

    if (!stopped) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    io.emit("taskUpdate", taskManager.getAllTasks());
    logger.success(`🛑 Task stopped: ${number}`);

    res.json({
      success: true,
      message: "Task stopped successfully",
    });
  } catch (error) {
    logger.error("API Error:", error.message);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Pause task
app.post("/api/tasks/:number/pause", (req, res) => {
  const paused = taskManager.pauseTask(req.params.number);
  if (!paused) {
    return res.status(404).json({
      success: false,
      message: "Task not found or already paused",
    });
  }

  io.emit("taskUpdate", taskManager.getAllTasks());
  logger.warn(`⏸️ Task paused: ${req.params.number}`);

  res.json({ success: true, message: "Task paused" });
});

// Resume task
app.post("/api/tasks/:number/resume", (req, res) => {
  const resumed = taskManager.resumeTask(req.params.number);
  if (!resumed) {
    return res.status(404).json({
      success: false,
      message: "Task not found or not paused",
    });
  }

  io.emit("taskUpdate", taskManager.getAllTasks());
  logger.success(`▶️ Task resumed: ${req.params.number}`);

  res.json({ success: true, message: "Task resumed" });
});

// Stop all tasks
app.delete("/api/tasks", async (req, res) => {
  try {
    const count = taskManager.stopAll();
    io.emit("taskUpdate", taskManager.getAllTasks());

    logger.warn(`🛑 All tasks stopped (${count} tasks)`);

    res.json({
      success: true,
      message: `${count} tasks stopped`,
      count,
    });
  } catch (error) {
    logger.error("API Error:", error.message);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Console endpoints
app.get("/api/console", (req, res) => {
  res.json({
    success: true,
    logs: logger.getHistory(),
    count: logger.history.length,
  });
});

app.delete("/api/console", (req, res) => {
  logger.clear();
  res.json({ success: true, message: "Console cleared" });
});

// Stats endpoint
app.get("/api/stats", (req, res) => {
  res.json({
    success: true,
    stats: taskManager.getStats(),
  });
});

// Export data
app.get("/api/export", async (req, res) => {
  try {
    const exportData = {
      tasks: taskManager.getAllTasks(),
      stats: taskManager.getStats(),
      logs: logger.getHistory(),
      exportDate: new Date().toISOString(),
    };

    res.setHeader("Content-Disposition", "attachment; filename=export.json");
    res.json(exportData);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Serve dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found",
  });
});

// Error handler
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error.message);
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: error.message,
  });
});

// Periodic stats broadcast
setInterval(() => {
  io.emit("statsUpdate", taskManager.getStats());
}, 5000);

// Periodic backup
setInterval(() => {
  taskManager.saveState();
  logger.saveLogs();
}, CONFIG.BACKUP_INTERVAL);

// Graceful shutdown
async function gracefulShutdown() {
  logger.warn("\n⏸️ Shutting down gracefully...");

  await taskManager.saveState();
  await logger.saveLogs();

  taskManager.stopAll();

  server.close(() => {
    logger.success("✅ Server closed successfully");
    process.exit(0);
  });

  setTimeout(() => {
    logger.error("❌ Forced shutdown");
    process.exit(1);
  }, 10000);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// Start server
async function start() {
  try {
    await ensureDir("./data");
    await logger.loadLogs();
    await taskManager.loadState();

    server.listen(CONFIG.PORT, () => {
      logger.success(`🚀 Server running at http://localhost:${CONFIG.PORT}`);
      logger.info(`📊 Dashboard: http://localhost:${CONFIG.PORT}`);
      logger.info(`🔧 API Docs: http://localhost:${CONFIG.PORT}/api/health`);
    });
  } catch (error) {
    logger.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

start();

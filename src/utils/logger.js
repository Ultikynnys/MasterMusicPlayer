class Logger {
  constructor() {
    // UI-only logger - no file system dependencies
    this.init();
  }

  async init() {
    // UI-only logger - no initialization needed
    this.sendToRenderer('info', 'Logger initialized successfully');
  }



  sendToRenderer(level, message, data = null) {
    try {
      // Only send to renderer if we're in the main process and have a window
      if (typeof process !== 'undefined' && process.type === 'browser') {
        const { BrowserWindow } = require('electron');
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('main-log', {
            level,
            message,
            data,
            timestamp: new Date().toISOString(),
            source: 'main'
          });
        }
      }
    } catch (error) {
      // Silently fail if renderer forwarding doesn't work
    }
  }

  async info(message, data = null) {
    this.sendToRenderer('info', message, data);
  }

  async warn(message, data = null) {
    this.sendToRenderer('warn', message, data);
  }

  async error(message, error = null, data = null) {
    let errorData = data;
    if (error) {
      errorData = {
        ...(data || {}),
        errorMessage: error.message,
        stack: error.stack
      };
    }
    
    this.sendToRenderer('error', message, errorData);
  }

  async debug(message, data = null) {
    this.sendToRenderer('debug', message, data);
  }

  async userAction(action, data = null) {
    this.sendToRenderer('user', `USER_ACTION: ${action}`, data);
  }

  async systemEvent(event, details = null) {
    this.sendToRenderer('system', `SYSTEM: ${event}`, details);
  }

  async performance(operation, duration, details = null) {
    this.sendToRenderer('performance', `PERFORMANCE: ${operation} completed in ${duration}ms`, details);
  }

  async crash(error, context = null) {
    const crashData = {
      errorMessage: error.message,
      stack: error.stack,
      context: context || 'No context provided'
    };
    
    this.sendToRenderer('error', 'Application crash detected', crashData);
  }

  async getLogs(type = 'all', limit = 100) {
    // UI-only logger - no file logs to retrieve
    return [];
  }

  async clearLogs(type = 'all') {
    // UI-only logger - no file logs to clear
    this.sendToRenderer('info', `Cleared logs: ${type}`);
  }
}

// Create singleton instance
const logger = new Logger();

module.exports = logger;

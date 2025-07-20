const { fork } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const logger = require('./logger');
const { generateTaskId } = require('./idGenerator');

/**
 * Process-based worker pool for downloading tracks in parallel
 * Uses child processes instead of worker threads for better memory isolation
 */
class ProcessWorkerPool extends EventEmitter {
  constructor(size = 16, ytDlpPath, ffmpegPath = null) {
    super();
    if (!ytDlpPath) {
      throw new Error('yt-dlp path is required to initialize worker pool');
    }
    this.workers = [];
    this.activeWorkers = 0;
    this.queue = [];
    this.size = size;
    this.taskPromises = new Map();
    this.workerScript = path.join(__dirname, 'downloadWorker.js');
    this.ytDlpPath = ytDlpPath;
    this.ffmpegPath = ffmpegPath;

    this.initializeWorkers();
  }

  initializeWorkers() {
    for (let i = 0; i < this.size; i++) {
      this.createWorker(i);
    }
    logger.info(`Initialized ${this.size} download workers using multiprocessing`);
  }

  createWorker(id) {
    const env = { ...process.env, WORKER_ID: id, YT_DLP_PATH: this.ytDlpPath };
    if (this.ffmpegPath) {
      env.FFMPEG_PATH = this.ffmpegPath;
    }
    
    const worker = fork(this.workerScript, [], {
      silent: false, // Allow worker to output to console for debugging
      env
    });

    const workerData = {
      id,
      process: worker,
      busy: false,
      tasksCompleted: 0
    };

    worker.on('message', (msg) => this.handleWorkerMessage(workerData, msg));
    worker.on('error', (err) => this.handleWorkerError(workerData, err));
    worker.on('exit', (code, signal) => this.handleWorkerExit(workerData, code, signal));

    this.workers.push(workerData);
    return workerData;
  }

  handleWorkerMessage(workerData, msg) {
    if (msg.type === 'log') {
      // Forward worker console logs to main process for UI display
      this.emit('workerLog', {
        workerId: workerData.id,
        level: msg.level,
        message: msg.message,
        data: msg.data
      });
      return;
    }
    if (msg.type === 'progress') {
            const taskPromise = this.taskPromises.get(msg.taskId);
      this.emit('progress', {
        taskId: msg.taskId,
        progress: msg.progress,
        workerId: workerData.id,
        trackInfo: taskPromise ? taskPromise.trackInfo : null
      });
      return;
    }
    if (msg.type === 'completed' || msg.type === 'failed') {
      this.activeWorkers--;
      workerData.busy = false;
      workerData.tasksCompleted++;

      const taskPromise = this.taskPromises.get(msg.taskId);
      if (taskPromise) {
        if (msg.type === 'completed') {
          taskPromise.resolve({ success: true, track: msg.result });
        } else if (msg.type === 'failed') {
          taskPromise.resolve({ success: false, error: msg.error, trackInfo: taskPromise.trackInfo });
        }
        this.taskPromises.delete(msg.taskId);
      }

      // Assign next task if available
      if (this.queue.length > 0) {
        this.assignNextTask();
      }
    }
  }

  handleWorkerError(workerData, err) {
    logger.error(`Worker ${workerData.id} error:`, err);
    this.activeWorkers--;
    workerData.busy = false;

    // Restart the worker
    this.restartWorker(workerData);
  }

  handleWorkerExit(workerData, code, signal) {
    logger.warn(`Worker ${workerData.id} exited with code ${code}, signal ${signal}`);
    this.activeWorkers--;
    workerData.busy = false;

    // Restart the worker if it wasn't intentionally terminated
    if (code !== 0 && signal !== 'SIGTERM') {
      this.restartWorker(workerData);
    }
  }

  restartWorker(oldWorkerData) {
    const index = this.workers.findIndex(w => w.id === oldWorkerData.id);
    if (index !== -1) {
      // Kill the old process if it's still running
      if (!oldWorkerData.process.killed) {
        oldWorkerData.process.kill('SIGTERM');
      }

      // Create a new worker with the same ID
      const newWorker = this.createWorker(oldWorkerData.id);
      this.workers[index] = newWorker;
      
      logger.info(`Restarted worker ${oldWorkerData.id}`);
    }
  }

  assignNextTask() {
    if (this.queue.length === 0 || this.activeWorkers >= this.size) return;

    const availableWorker = this.workers.find(w => !w.busy);
    if (availableWorker) {
      const task = this.queue.shift();
      availableWorker.busy = true;
      this.activeWorkers++;
      
      availableWorker.process.send(task);
      logger.info(`Assigned task ${task.taskId} to worker ${availableWorker.id}. Queue: ${this.queue.length}, Active: ${this.activeWorkers}`);
    }
  }

  addTask(trackInfo, songsPath, playlistId) {
    const taskId = generateTaskId(playlistId, trackInfo.id);
    
    // Include cookies path so worker can find cookies.txt
    const { app } = require('electron');
    const path = require('path');
    const cookiesPath = path.join(app.getPath('userData'), 'cookies.txt');
    
    const task = {
      type: 'downloadTrack',
      taskId,
      trackInfo,
      songsPath,
      cookiesPath
    };

    return new Promise((resolve) => {
      this.taskPromises.set(taskId, { resolve, trackInfo });
      this.queue.push(task);
      logger.info(`Added download task for "${trackInfo.title}". Queue length: ${this.queue.length}`);
      this.assignNextTask();
    });
  }

  getStats() {
    return {
      totalWorkers: this.size,
      activeWorkers: this.activeWorkers,
      queueLength: this.queue.length,
      completedTasks: this.workers.reduce((sum, w) => sum + w.tasksCompleted, 0)
    };
  }

  async terminate() {
    logger.info('Terminating process worker pool...');
    
    // Clear the queue
    this.queue = [];
    
    // Reject any pending promises
    for (const [taskId, promise] of this.taskPromises) {
      promise.resolve({ success: false, error: 'Worker pool terminated', trackInfo: promise.trackInfo });
    }
    this.taskPromises.clear();

    // Terminate all workers
    const terminationPromises = this.workers.map(worker => {
      return new Promise((resolve) => {
        if (worker.process.killed) {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          worker.process.kill('SIGKILL');
          resolve();
        }, 5000); // Force kill after 5 seconds

        worker.process.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        worker.process.kill('SIGTERM');
      });
    });

    await Promise.all(terminationPromises);
    this.workers = [];
    this.activeWorkers = 0;
    
    logger.info('Process worker pool terminated');
  }
}

module.exports = ProcessWorkerPool;

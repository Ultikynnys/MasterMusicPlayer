const fs = require('fs-extra');
const path = require('path');
const logger = require('./logger');

class FileLock {
  constructor(lockDir) {
    this.lockDir = lockDir;
    this.locks = new Map();
    this.ensureLockDir();
  }

  ensureLockDir() {
    if (!fs.existsSync(this.lockDir)) {
      fs.mkdirSync(this.lockDir, { recursive: true });
    }
  }

  acquire(filePath) {
    const lockFile = this.getLockFilePath(filePath);
    if (this.locks.has(filePath)) {
      return false;
    }

    try {
      // Create a lock file as a way to signal that the resource is in use
      fs.writeFileSync(lockFile, process.pid.toString(), { flag: 'wx' });
      this.locks.set(filePath, lockFile);
      logger.info(`Lock acquired for ${filePath}`);
      return true;
    } catch (error) {
      logger.warn(`Failed to acquire lock for ${filePath}`, error);
      return false;
    }
  }

  release(filePath) {
    if (!this.locks.has(filePath)) {
      logger.warn(`No lock to release for ${filePath}`);
      return false;
    }

    const lockFile = this.locks.get(filePath);
    try {
      if (fs.existsSync(lockFile)) {
        fs.unlinkSync(lockFile);
      }
      this.locks.delete(filePath);
      logger.info(`Lock released for ${filePath}`);
      return true;
    } catch (error) {
      logger.error(`Error releasing lock for ${filePath}`, error);
      return false;
    }
  }

  getLockFilePath(filePath) {
    const fileName = path.basename(filePath);
    return path.join(this.lockDir, `${fileName}.lock`);
  }

  isLocked(filePath) {
    return this.locks.has(filePath) || fs.existsSync(this.getLockFilePath(filePath));
  }
}

module.exports = FileLock;

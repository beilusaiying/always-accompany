/**
 * @module file-reader
 * 
 * @description
 * Exports a class {@link FileReader}, used internally to handle 
 * access when a string filename is passed. This provides a consistent
 * interface between reading from files and buffers, so that in-memory
 * files can be handled efficiently.
 */

const fs = require('fs');

/**
 * A class that allows a reader to access file through the file system.
 * This can be used as an alternative to the 
 * [BufferReader]{@link module:buffer-reader~BufferReader} which
 * reads direct from a buffer. 
 */
class FileReader {

  /**
   * Creates a new file reader instance, using the given filename.
   * @param {*} filename 
   */
  constructor(filename) {
    this._filename = filename;
  }

  /**
   * Opens the file descriptor for a file, and returns a promise that resolves
   * when the file is open. After this, {@link FileReader#read} can be called 
   * to read file content into a buffer.
   * @returns a promise
   */
  open() {
    return new Promise((resolve, reject) => {
      fs.open(this._filename, 'r', 0o666, (err, fd) => {
        if(err) {
          return reject(err);
        }
  
        this._fd = fd;
        resolve();
      });  
    });
  }

  /**
   * Closes the file descriptor associated with an open document, if there
   * is one, and returns a promise that resolves when the file handle is closed.
   * @returns a promise
   */
  close() {
    return new Promise((resolve, reject) => {
      if (this._fd) {
        fs.close(this._fd, (err) => {
          if (err) {
            return reject(err);
          }
          delete this._fd;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }


  /**
   * Reads a buffer of `length` bytes into the `buffer`. The new data will
   * be added to the buffer at offset `offset`, and will be read from the
   * file starting at position `position`
   * @param {*} buffer 
   * @param {*} offset 
   * @param {*} length 
   * @param {*} position 
   * @returns a promise that resolves to the buffer when the data is present
   */
  read(buffer, offset, length, position) {
    return new Promise((resolve, reject) => {
      if ( !this._fd) {
        return reject(new Error("file not open"));
      }
      fs.read(this._fd, buffer, offset, length, position, (err, bytesRead, buffer) => {
        if (err) {
          return reject(err);
        }
        resolve(buffer);
      });
    });
  }

  /**
   * Returns the open file descriptor
   * @returns the file descriptor
   */
  fd() {
    return this._fd;
  }

  /**
   * Returns true if the passed instance is an instance of this class.
   * @param {*} instance 
   * @returns true if `instance` is an instance of {@link FileReader}.
   */
  static isFileReader(instance) {
    return instance instanceof FileReader;
  }

}

module.exports = FileReader;

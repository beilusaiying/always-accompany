/**
 * @module buffer-reader
 * 
 * @description
 * Exports a class {@link BufferReader}, used internally to handle 
 * access when an input buffer is passed. This provides a consistent
 * interface between reading from files and buffers, so that in-memory
 * files can be handled efficiently.
 */

/**
 * A class that allows a reader to access file through the file system.
 * This can be used as an alternative to the 
 * [FileReader]{@link module:file-reader~FileReader} which
 * reads direct from an opened file descriptor. 
 */
class BufferReader {

  constructor(buffer) {
    this._buffer = buffer;
  }

  open() {
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }

  read(buffer, offset, length, position) {
    this._buffer.copy(buffer, offset, position, position + length);
    return Promise.resolve(buffer);
  }

  buffer() {
    return this._buffer;
  }

  static isBufferReader(instance) {
    return instance instanceof BufferReader;
  }
}

module.exports = BufferReader;

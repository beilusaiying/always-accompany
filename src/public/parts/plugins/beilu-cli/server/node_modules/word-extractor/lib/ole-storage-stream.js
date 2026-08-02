const { Readable } = require('stream');

class StorageStream extends Readable {

  constructor(doc, streamEntry) {
    super();
    this._doc = doc;
    this._streamEntry = streamEntry;
    this.initialize();
  }

  initialize() {
    this._index = 0;
    this._done = true;

    if (!this._streamEntry) {
      return;
    }

    const doc  = this._doc;
    this._bytes = this._streamEntry.size;
  
    this._allocationTable = doc._SAT;
    this._shortStream = false;
    if (this._bytes < doc._header.shortStreamMax) {
      this._shortStream = true;
      this._allocationTable = doc._SSAT;
    }
  
    this._secIds = this._allocationTable.getSecIdChain(this._streamEntry.secId);
    this._done = false;
  }

  _readSector(sector) {
    if (this._shortStream) {
      return this._doc._readShortSector(sector);
    } else {
      return this._doc._readSector(sector);
    }
  }

  _read() {
    if (this._done) {
      return this.push(null);
    }

    if (this._index >= this._secIds.length) {
      this._done = true;
      return this.push(null);
    }

    return this._readSector(this._secIds[this._index])
      .then((buffer) => {
        if (this._bytes - buffer.length < 0) {
          buffer = buffer.slice(0, this._bytes);
        }
      
        this._bytes -= buffer.length;
        this._index ++;
        this.push(buffer);
      });
  }
}

module.exports = StorageStream;
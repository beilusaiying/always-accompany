const StorageStream = require('./ole-storage-stream');

class Storage {

  constructor(doc, dirEntry) {
    this._doc = doc;
    this._dirEntry = dirEntry;
  }

  storage(storageName) {
    return new Storage(this._doc, this._dirEntry.storages[storageName]);
  }
  
  stream(streamName) {
    return new StorageStream(this._doc, this._dirEntry.streams[streamName]);
  }
  
}

module.exports = Storage;
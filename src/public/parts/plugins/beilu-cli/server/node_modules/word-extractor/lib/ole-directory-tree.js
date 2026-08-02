const DIRECTORY_TREE_ENTRY_TYPE_EMPTY =       0;   // eslint-disable-line no-unused-vars
const DIRECTORY_TREE_ENTRY_TYPE_STORAGE =     1;
const DIRECTORY_TREE_ENTRY_TYPE_STREAM =      2;
const DIRECTORY_TREE_ENTRY_TYPE_ROOT =        5;

const DIRECTORY_TREE_NODE_COLOR_RED =         0;   // eslint-disable-line no-unused-vars
const DIRECTORY_TREE_NODE_COLOR_BLACK =       1;   // eslint-disable-line no-unused-vars

const DIRECTORY_TREE_LEAF =                  -1;

class DirectoryTree {

  constructor(doc) {
    this._doc = doc;
  }

  load(secIds) {
    const doc = this._doc;

    return doc._readSectors(secIds)
      .then((buffer) => {
        const count = buffer.length / 128;
        this._entries = new Array(count);
        for(let i = 0; i < count; i++) {
          const offset = i * 128;
          const nameLength = Math.max(buffer.readInt16LE(64 + offset) - 1, 0);
  
          const entry = {};
          entry.name = buffer.toString('utf16le', 0 + offset, nameLength + offset);
          entry.type = buffer.readInt8(66 + offset);
          entry.nodeColor = buffer.readInt8(67 + offset);
          entry.left = buffer.readInt32LE(68 + offset);
          entry.right = buffer.readInt32LE(72 + offset);
          entry.storageDirId = buffer.readInt32LE(76 + offset);
          entry.secId = buffer.readInt32LE(116 + offset);
          entry.size = buffer.readInt32LE(120 + offset);
    
          this._entries[i] = entry;
        }
    
        this.root = this._entries.find((entry) => entry.type === DIRECTORY_TREE_ENTRY_TYPE_ROOT);
        this._buildHierarchy(this.root);
      });
  }

  _buildHierarchy(storageEntry) {
    const childIds = this._getChildIds(storageEntry);
  
    storageEntry.storages = {};
    storageEntry.streams  = {};

    for(const childId of childIds) {
      const childEntry = this._entries[childId];
      const name = childEntry.name;
      if (childEntry.type === DIRECTORY_TREE_ENTRY_TYPE_STORAGE) {
        storageEntry.storages[name] = childEntry;
      }
      if (childEntry.type === DIRECTORY_TREE_ENTRY_TYPE_STREAM) {
        storageEntry.streams[name] = childEntry;
      }
    }

    for(const name in storageEntry.storages) {
      this._buildHierarchy(storageEntry.storages[name]);
    }
  }
  
  _getChildIds(storageEntry) {
    const childIds = [];
  
    const visit = (visitEntry) => {
      if (visitEntry.left !== DIRECTORY_TREE_LEAF) {
        childIds.push(visitEntry.left);
        visit(this._entries[visitEntry.left]);
      }
      if (visitEntry.right !== DIRECTORY_TREE_LEAF) {
        childIds.push(visitEntry.right);
        visit(this._entries[visitEntry.right]);
      }
    };
  
    if (storageEntry.storageDirId > -1) {
      childIds.push(storageEntry.storageDirId);
      const rootChildEntry = this._entries[storageEntry.storageDirId];
      visit(rootChildEntry);
    }
  
    return childIds;
  }

}

module.exports = DirectoryTree;

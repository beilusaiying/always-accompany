/**
 * @module ole-compound-doc
 */

// Copyright (c) 2012 Chris Geiersbach
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// This component as adapted from node-ole-doc, available at:
// https://github.com/atariman486/node-ole-doc.
//
// Modified extensively by Stuart Watt <stuart@morungos.com> to keep the 
// principal logic, but replacing callbacks and some weird stream usages
// with promises.

const Header = require('./ole-header');
const AllocationTable = require('./ole-allocation-table');
const DirectoryTree = require('./ole-directory-tree');
const Storage = require('./ole-storage');

/**
 * Implements the main interface used to read from an OLE compoound file.
 */
class OleCompoundDoc {

  constructor(reader) {    
    this._reader = reader;
    this._skipBytes = 0;
  }

  read() {
    return Promise.resolve()
      .then(() => this._readHeader())
      .then(() => this._readMSAT())
      .then(() => this._readSAT())
      .then(() => this._readSSAT())
      .then(() => this._readDirectoryTree())
      .then(() => {
        if (this._skipBytes != 0) {
          return this._readCustomHeader();
        }
      })
      .then(() => this);
  }

  _readCustomHeader() {
    const buffer = Buffer.alloc(this._skipBytes);
    return this._reader.read(buffer, 0, this._skipBytes, 0)
      .then((buffer) => {
        if (!this._customHeaderCallback(buffer))
          return;
      });
  }

  _readHeader() {
    const buffer = Buffer.alloc(512);
    return this._reader.read(buffer, 0, 512, 0 + this._skipBytes)
      .then((buffer) => {
        const header = this._header = new Header();
        if (!header.load(buffer)) {
          throw new Error("Not a valid compound document");
        }
      });
  }

  _readMSAT() {
    const header = this._header;

    this._MSAT = header.partialMSAT.slice(0);
    this._MSAT.length = header.SATSize;

    if(header.SATSize <= 109 || header.MSATSize == 0) {
      return Promise.resolve();
    }

    let currMSATIndex = 109;
    let i = 0;

    const readOneMSAT = (i, currMSATIndex, secId) => {
      if (i >= header.MSATSize) {
        return Promise.resolve();
      }

      return this._readSector(secId)
        .then((sectorBuffer) => {
          let s;
          for(s = 0; s < header.secSize - 4; s += 4) {
            if(currMSATIndex >= header.SATSize)
              break;
            else
              this._MSAT[currMSATIndex] = sectorBuffer.readInt32LE(s);

            currMSATIndex++;
          }

          secId = sectorBuffer.readInt32LE(header.secSize - 4);
          return readOneMSAT(i + 1, currMSATIndex, secId);
        });
    };

    return readOneMSAT(i, currMSATIndex, header.MSATSecId);
  }

  _readSector(secId) {
    return this._readSectors([ secId ]);
  }

  _readSectors(secIds) {
    const header = this._header;
    const buffer = Buffer.alloc(secIds.length * header.secSize);

    const readOneSector = (i) => {
      if (i >= secIds.length) {
        return Promise.resolve(buffer);
      }

      const bufferOffset = i * header.secSize;
      const fileOffset = this._getFileOffsetForSec(secIds[i]);

      return this._reader.read(buffer, bufferOffset, header.secSize, fileOffset)
        .then(() => readOneSector(i + 1));
    };

    return readOneSector(0);
  }

  _readShortSector(secId) {
    return this._readShortSectors([ secId ]);
  }

  _readShortSectors(secIds) {
    const header = this._header;
    const buffer = Buffer.alloc(secIds.length * header.shortSecSize);

    const readOneShortSector = (i) => {
      if (i >= secIds.length) {
        return Promise.resolve(buffer);
      }

      const bufferOffset = i * header.shortSecSize;
      const fileOffset = this._getFileOffsetForShortSec(secIds[i]);

      return this._reader.read(buffer, bufferOffset, header.shortSecSize, fileOffset)
        .then(() => readOneShortSector(i + 1));
    };

    return readOneShortSector(0);
  }

  _readSAT() {
    this._SAT = new AllocationTable(this);
    return this._SAT.load(this._MSAT);
  }

  _readSSAT() {
    const header = this._header;

    const secIds = this._SAT.getSecIdChain(header.SSATSecId);
    if (secIds.length != header.SSATSize) {
      return Promise.reject(new Error("Invalid Short Sector Allocation Table"));
    }

    this._SSAT = new AllocationTable(this);
    return this._SSAT.load(secIds);
  }

  _readDirectoryTree() {
    const header = this._header;

    this._directoryTree = new DirectoryTree(this);

    const secIds = this._SAT.getSecIdChain(header.dirSecId);
    return this._directoryTree.load(secIds)
      .then(() => {
        const rootEntry = this._directoryTree.root;
        this._rootStorage = new Storage(this, rootEntry);
        this._shortStreamSecIds = this._SAT.getSecIdChain(rootEntry.secId);
      });
  }

  _getFileOffsetForSec(secId) {
    const secSize = this._header.secSize;
    return this._skipBytes + (secId + 1) * secSize;  // Skip past the header sector
  }

  _getFileOffsetForShortSec(shortSecId) {
    const shortSecSize = this._header.shortSecSize;
    const shortStreamOffset = shortSecId * shortSecSize;

    const secSize = this._header.secSize;
    const secIdIndex = Math.floor(shortStreamOffset / secSize);
    const secOffset = shortStreamOffset % secSize;
    const secId = this._shortStreamSecIds[secIdIndex];

    return this._getFileOffsetForSec(secId) + secOffset;
  }

  storage(storageName) {
    return this._rootStorage.storage(storageName);
  }

  stream(streamName) {
    return this._rootStorage.stream(streamName);
  }

}

module.exports = OleCompoundDoc;

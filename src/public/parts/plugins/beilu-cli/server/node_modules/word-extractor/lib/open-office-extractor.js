
/**
 * @module open-office-extractor
 * 
 * @description
 * Implements the main Open Office format extractor. Open Office .docx files
 * are essentially zip files containing streams, and each of these streams contains
 * XML content in one form or another. So we need to use {@link zlib} to extract
 * the streams, and something like `sax-js` to parse the XML that we find 
 * there. 
 * 
 * We probably don't need the whole of the Open Office data, we're only likely
 * to need a few streams. Sadly, the documentation for the file format is literally
 * 5000 pages.
 * Note that [WordOleExtractor]{@link module:word-ole-extractor~WordOleExtractor} is 
 * used for older, OLE-style, compound document files. 
 */

const path = require('path');
const SAXES = require("saxes");
const yauzl = require('yauzl');

const BufferReader = require('./buffer-reader');
const FileReader = require('./file-reader');
const Document = require('./document');

// function getEntryWeight(filename) {
//   return 1;
// }

function each(callback, array, index) {
  if (index === array.length) {
    return Promise.resolve();
  } else {
    return Promise.resolve(callback(array[index++]))
      .then(() => each(callback, array, index));
  }
}

/**
 * @class
 * The main class implementing extraction from Open Office Word files.
 */
class OpenOfficeExtractor {

  constructor() { 
    this._streamTypes = {
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml': true,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml': true,
      'application/vnd.openxmlformats-package.relationships+xml': true
    };
    this._headerTypes = {
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header': true,
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer': true
    };
    this._actions = {};
    this._defaults = {};
  }

  shouldProcess(filename) {
    if (this._actions[filename]) {
      return true;
    }
    const extension = path.posix.extname(filename).replace(/^\./, '');
    if (! extension) {
      return false;
    }
    const defaultType = this._defaults[extension];
    if (defaultType && this._streamTypes[defaultType]) {
      return true;
    }
    return false;
  }

  openArchive(reader) {
    if (BufferReader.isBufferReader(reader)) {
      return new Promise((resolve, reject) => {
        yauzl.fromBuffer(reader.buffer(), {lazyEntries: true}, function(err, zipfile) {
          if (err) {
            return reject(err);
          }
          resolve(zipfile);
        });
      });
    } else if (FileReader.isFileReader(reader)) {
      return new Promise((resolve, reject) => {
        yauzl.fromFd(reader.fd(), {lazyEntries: true, autoClose: false}, function(err, zipfile) {
          if (err) {
            return reject(err);
          }
          resolve(zipfile);
        });
      });
    } else {
      throw new Error("Unexpected reader type: " + reader.constructor.name);
    }
  }

  processEntries(zipfile) {
    let entryTable = {};
    let entryNames = [];
    return new Promise((resolve, reject) => {
      zipfile.readEntry();
      zipfile.on("error", reject);
      zipfile.on("entry", (entry) => {
        const filename = entry.fileName;

        entryTable[filename] = entry;
        entryNames.push(filename);
        zipfile.readEntry();
      });
      zipfile.on("end", () => resolve(this._document));
    })
      .then(() => {

        // Re-order, so the content types are always loaded first
        const index = entryNames.indexOf('[Content_Types].xml');
        if (index === -1) {
          throw new Error("Invalid Open Office XML: missing content types");
        }

        entryNames.splice(index, 1);
        entryNames.unshift('[Content_Types].xml');
        this._actions['[Content_Types].xml'] = true;

        return each((name) => {
          if (this.shouldProcess(name)) {
            return this.handleEntry(zipfile, entryTable[name]);
          }
        }, entryNames, 0);
      });
  }

  extract(reader) {
    let archive = this.openArchive(reader);

    this._document = new Document();
    this._relationships = {};
    this._entryTable = {};
    this._entries = [];

    return archive
      .then((zipfile) => this.processEntries(zipfile))
      .then(() => {
        let document = this._document;
        if (document._textboxes && document._textboxes.length > 0) {
          document._textboxes = document._textboxes + "\n";
        }
        if (document._headerTextboxes && document._headerTextboxes.length > 0) {
          document._headerTextboxes = document._headerTextboxes + "\n";
        }
        return document;
      });

  }

  handleOpenTag(node) {
    if (node.name === 'Override') {
      const actionFunction = this._streamTypes[node.attributes['ContentType']];
      if (actionFunction) {
        const partName = node.attributes['PartName'].replace(/^[/]+/, '');
        const action = {action: actionFunction, type: node.attributes['ContentType']};
        this._actions[partName] = action;
      }
    } else if (node.name === 'Default') {
      const extension = node.attributes['Extension'];
      const contentType = node.attributes['ContentType'];
      this._defaults[extension] = contentType;
    } else if (node.name === 'Relationship') {
      // console.log(this._source, node);
      this._relationships[node.attributes['Id']] = {
        type: node.attributes['Type'],
        target: node.attributes['Target'],
      };
    } else if (node.name === 'w:document' || 
               node.name === 'w:footnotes' || 
               node.name === 'w:endnotes' || 
               node.name === 'w:comments') {
      this._context = ['content', 'body'];
      this._pieces = [];
    } else if (node.name === 'w:hdr' ||
               node.name === 'w:ftr') {
      this._context = ['content', 'header'];
      this._pieces = [];
    } else if (node.name === 'w:endnote' || node.name === 'w:footnote') {
      const type = (node.attributes['w:type'] || this._context[0]);
      this._context.unshift(type);
    } else if (node.name === 'w:tab' && this._context[0] === 'content') {
      this._pieces.push("\t");
    } else if (node.name === 'w:br' && this._context[0] === 'content') {
      if ((node.attributes['w:type'] || '') === 'page') {
        this._pieces.push("\n");
      } else {
        this._pieces.push("\n");
      }
    } else if (node.name === 'w:del' || node.name === 'w:instrText') {
      this._context.unshift('deleted');
    } else if (node.name === 'w:tabs') {
      this._context.unshift('tabs');
    } else if (node.name === 'w:tc') {
      this._context.unshift('cell');
    } else if (node.name === 'w:drawing') {
      this._context.unshift('drawing');
    } else if (node.name === 'w:txbxContent') {
      this._context.unshift(this._pieces);
      this._context.unshift('textbox');
      this._pieces = [];
    }
  }

  handleCloseTag(node) {
    if (node.name === 'w:document') {
      this._context = null;
      this._document._body = this._pieces.join("");
    } else if (node.name === 'w:footnote' || node.name === 'w:endnote') {
      this._context.shift();
    } else if (node.name === 'w:footnotes') {
      this._context = null;
      this._document._footnotes = this._pieces.join("");
    } else if (node.name === 'w:endnotes') {
      this._context = null;
      this._document._endnotes = this._pieces.join("");
    } else if (node.name === 'w:comments') {
      this._context = null;
      this._document._annotations = this._pieces.join("");
    } else if (node.name === 'w:hdr') {
      this._context = null;
      this._document._headers = this._document._headers + this._pieces.join("");
    } else if (node.name === 'w:ftr') {
      this._context = null;
      this._document._footers = this._document._footers + this._pieces.join("");
    } else if (node.name === 'w:p') {
      if (this._context[0] === 'content' || this._context[0] === 'cell' || this._context[0] === 'textbox') {
        this._pieces.push("\n");
      }
    } else if (node.name === 'w:del' || node.name === 'w:instrText') {
      this._context.shift();
    } else if (node.name === 'w:tabs') {
      this._context.shift();
    } else if (node.name === 'w:tc') {
      this._pieces.pop();
      this._pieces.push("\t");
      this._context.shift();
    } else if (node.name === 'w:tr') {
      this._pieces.push("\n");
    } else if (node.name === 'w:drawing') {
      this._context.shift();
    } else if (node.name === 'w:txbxContent') {
      const textBox = this._pieces.join("");
      const context = this._context.shift();
      if (context !== 'textbox') {
        throw new Error("Invalid textbox context");
      }
      this._pieces = this._context.shift();
      
      // If in drawing context, discard
      if (this._context[0] === 'drawing')
        return;

      if (textBox.length == 0)
        return;
      
      const inHeader = this._context.includes('header');
      const documentField = (inHeader) ? '_headerTextboxes' : '_textboxes';
      if (this._document[documentField]) {
        this._document[documentField] = this._document[documentField] + "\n" + textBox;
      } else {
        this._document[documentField] = textBox;
      }
    }
  }

  createXmlParser() {
    const parser = new SAXES.SaxesParser(); 

    parser.on("opentag", (node) => {
      try {
        this.handleOpenTag(node);
      } catch (e) {
        parser.fail(e.message);
      }
    });

    parser.on('closetag', (node) => {
      try {
        this.handleCloseTag(node);
      } catch (e) {
        parser.fail(e.message);
      }
    });

    parser.on('text', (string) => {
      try {
        if (! this._context)
          return;
        if (this._context[0] === 'content' || this._context[0] === 'cell' || this._context[0] === 'textbox') {
          this._pieces.push(string);
        }
      } catch (e) {
        parser.fail(e.message);
      }
    });

    return parser;
  }

  handleEntry(zipfile, entry) {
    return new Promise((resolve, reject) => {
      zipfile.openReadStream(entry, (err, readStream) => {
        if (err) {
          return reject(err);
        }

        this._source = entry.fileName;
        const parser = this.createXmlParser();
        parser.on("error", (e) => {
          readStream.destroy(e);
          reject(e);
        });
        parser.on("end", () => resolve());
        readStream.on("end", () => parser.close());
        readStream.on("error", (e) => reject(e));
        readStream.on("readable", () => {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const chunk = readStream.read(0x1000);
            if (chunk === null) {
              return;
            }
      
            parser.write(chunk);
          }
        });
      });  
    });
  }

}

module.exports = OpenOfficeExtractor;

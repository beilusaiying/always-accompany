/**
 * @module word
 * 
 * @description
 * The main module for the package. This exports an extractor class, which
 * provides a single `extract` method that can be called with either a 
 * string (filename) or a buffer.
 */

const { Buffer } =          require('buffer');

const WordOleExtractor =    require('./word-ole-extractor');
const OpenOfficeExtractor = require('./open-office-extractor');

const BufferReader =        require('./buffer-reader');
const FileReader =          require('./file-reader');

/**
 * The main class for the word extraction package. Typically, people will make
 * an instance of this class, and call the {@link #extract} method to transform 
 * a Word file into a {@link Document} instance, which provides the accessors
 * needed to read its body, and so on.
 */
class WordExtractor {

  constructor() {}

  /**
   * Extracts the main contents of the file. If a Buffer is passed, that
   * is used instead. Opens the file, and reads the first block, uses that
   * to detect whether this is a .doc file or a .docx file, and then calls
   * either {@link WordOleDocument#extract} or {@link OpenOfficeDocument#extract}
   * accordingly.
   * 
   * @param {string|Buffer} source - either a string filename, or a Buffer containing the file content
   * @returns a {@link Document} providing accessors onto the text
   */
  extract(source) {
    let reader = null;
    if (Buffer.isBuffer(source)) {
      reader = new BufferReader(source);
    } else if (typeof source === 'string') {
      reader = new FileReader(source);
    }
    const buffer = Buffer.alloc(512);
    return reader.open()
      .then(() => reader.read(buffer, 0, 512, 0))
      .then((buffer) => {
        let extractor = null;

        if (buffer.readUInt16BE(0) === 0xd0cf) {
          extractor = WordOleExtractor;
        } else if (buffer.readUInt16BE(0) === 0x504b) {
          const next = buffer.readUInt16BE(2);
          if ((next === 0x0304) || (next === 0x0506) || (next === 0x0708)) {
            extractor = OpenOfficeExtractor;
          }
        }

        if (! extractor) {
          throw new Error("Unable to read this type of file");
        }

        return (new extractor()).extract(reader);
      })
      .finally(() => reader.close());
  }

}


module.exports = WordExtractor;

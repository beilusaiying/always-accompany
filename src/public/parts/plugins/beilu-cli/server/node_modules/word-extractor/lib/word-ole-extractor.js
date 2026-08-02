/**
 * @module word-ole-extractor
 * 
 * @description
 * Implements the main logic of extracting text from "classic" OLE-based Word files.
 * Depends on [OleCompoundDoc]{@link module:ole-compound-doc~OleCompoundDoc} 
 * for most of the underlying OLE logic. Note that
 * [OpenOfficeExtractor]{@link module:open-office-extractor~OpenOfficeExtractor} is 
 * used for newer, Open Office-style, files. 
 */

const OleCompoundDoc = require('./ole-compound-doc');
const Document = require('./document');
const { binaryToUnicode, clean } = require('./filters');

/**
 * Constant for the deletion character SPRM.
 */
const sprmCFRMarkDel = 0x00;

/**
 * Given a cp-style file offset, finds the containing piece index.
 * @param {*} offset the character offset
 * @returns the piece index
 * 
 * @todo 
 * Might be better using a binary search
 */
const getPieceIndexByCP = (pieces, position) => {
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (position <= piece.endCp) { 
      return i; 
    }
  }
};

/**
 * Given a file-style offset, finds the containing piece index.
 * @param {*} offset the character offset
 * @returns the piece index
 * 
 * @todo 
 * Might be better using a binary search
 */
const getPieceIndexByFilePos = (pieces, position) => {
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (position <= piece.endFilePos) { 
      return i; 
    }
  }
};

/**
 * Reads and extracts a character range from the pieces. This returns the 
 * plain text within the pieces in the given range.
 * @param {*} start the start offset
 * @param {*} end the end offset
 * @returns a character string
 */
function getTextRangeByCP(pieces, start, end) {
  const startPiece = getPieceIndexByCP(pieces, start);
  const endPiece = getPieceIndexByCP(pieces, end);
  const result = [];
  for (let i = startPiece, end1 = endPiece; i <= end1; i++) {
    const piece = pieces[i];
    const xstart = i === startPiece ? start - piece.startCp : 0;
    const xend = i === endPiece ? end - piece.startCp : piece.endCp;
    result.push(piece.text.substring(xstart, xend));
  }

  return result.join("");
}


/**
 * Given a piece, and a starting and ending cp-style file offset, 
 * and a replacement character, updates the piece text to replace
 * between start and end with the given character.
 * @param {*} piece the piece
 * @param {*} start the starting character offset
 * @param {*} end the endingcharacter offset
 * @param {*} character the replacement character
 */
function fillPieceRange(piece, start, end, character) {
  const pieceStart = piece.startCp;
  const pieceEnd = pieceStart + piece.length;
  const original = piece.text;
  if (start < pieceStart) start = pieceStart;
  if (end > pieceEnd) end = pieceEnd;
  const modified = 
    ((start == pieceStart) ? '' : original.slice(0, start - pieceStart)) +
    ''.padStart(end - start, character) +
    ((end == pieceEnd) ? '' : original.slice(end - pieceEnd));
  piece.text = modified;
}

/**
 * Given a piece, and a starting and ending filePos-style file offset, 
 * and a replacement character, updates the piece text to replace
 * between start and end with the given character. This is used when
 * applying character styles, which use filePos values rather than cp
 * values.
 *
 * @param {*} piece the piece
 * @param {*} start the starting character offset
 * @param {*} end the endingcharacter offset
 * @param {*} character the replacement character
 */
function fillPieceRangeByFilePos(piece, start, end, character) {
  const pieceStart = piece.startFilePos;
  const pieceEnd = pieceStart + piece.size;
  const original = piece.text;
  if (start < pieceStart) start = pieceStart;
  if (end > pieceEnd) end = pieceEnd;
  const modified = 
    ((start == pieceStart) ? '' : original.slice(0, (start - pieceStart) / piece.bpc)) +
    ''.padStart((end - start) / piece.bpc, character) +
    ((end == pieceEnd) ? '' : original.slice((end - pieceEnd) / piece.bpc));
  piece.text = modified;
}

/**
 * Replaces a selected range in the piece table, overwriting the selection with 
 * the given character. The length of segments in the piece table must never be
 * changed. 
 * @param {*} pieces 
 * @param {*} start 
 * @param {*} end 
 * @param {*} character 
 */
function replaceSelectedRange(pieces, start, end, character) {     // eslint-disable-line no-unused-vars
  const startPiece = getPieceIndexByCP(pieces, start);
  const endPiece = getPieceIndexByCP(pieces, end);
  for (let i = startPiece, end1 = endPiece; i <= end1; i++) {
    const piece = pieces[i];
    fillPieceRange(piece, start, end, character);
  }
}

/**
 * Replaces a selected range in the piece table, overwriting the selection with 
 * the given character. The length of segments in the piece table must never be
 * changed. The start and end values are found by file position.
 * @param {*} pieces 
 * @param {*} start 
 * @param {*} end 
 * @param {*} character 
 */
function replaceSelectedRangeByFilePos(pieces, start, end, character) {
  const startPiece = getPieceIndexByFilePos(pieces, start);
  const endPiece = getPieceIndexByFilePos(pieces, end);
  for (let i = startPiece, end1 = endPiece; i <= end1; i++) {
    const piece = pieces[i];
    fillPieceRangeByFilePos(piece, start, end, character);
  }
}

/**
 * Marks a range as deleted. It does this by overwriting it with null characters,
 * wich then get removed during the later cleaning process.
 * @param {*} pieces 
 * @param {*} start 
 * @param {*} end 
 */
function markDeletedRange(pieces, start, end) {
  replaceSelectedRangeByFilePos(pieces, start, end, '\x00');
}

/**
 * Called to iterate over a set of SPRMs in a buffer, starting at 
 * a gived offset. The handler is called with the arguments:
 * buffer, offset, sprm, ispmd, fspec, sgc, spra.
 * @param {*} buffer the buffer
 * @param {*} offset the starting offset
 * @param {*} handler the function to call for each SPRM
 */
const processSprms = (buffer, offset, handler) => {
  while (offset < buffer.length - 1) {
    const sprm = buffer.readUInt16LE(offset);
    const ispmd = sprm & 0x1f;
    const fspec = (sprm >> 9) & 0x01;
    const sgc = (sprm >> 10) & 0x07;
    const spra = (sprm >> 13) & 0x07;

    offset += 2;

    handler(buffer, offset, sprm, ispmd, fspec, sgc, spra);

    if (spra === 0) {
      offset += 1;
      continue;
    } else if (spra === 1) {
      offset += 1;
      continue;
    } else if (spra === 2) {
      offset += 2;
      continue;
    } else if (spra === 3) {
      offset += 4;
      continue;
    } else if (spra === 4 || spra === 5) {
      offset += 2;
      continue;
    } else if (spra === 6) {
      offset += buffer.readUInt8(offset) + 1;
      continue;
    } else if (spra === 7) {
      offset += 3;
      continue;
    } else {
      throw new Error("Unparsed sprm");
    }

  }
};

/**
 * @class
 * The main class implementing extraction from OLE-based Word files. 
 * This handles all the extraction and conversion logic. 
 */
class WordOleExtractor {

  constructor() { 
    this._pieces = [];
    this._bookmarks = {};
    this._boundaries = {};
    this._taggedHeaders = [];
  }

  /**
   * The main extraction method. This creates an OLE compound document
   * interface, then opens up a stream and extracts out the main
   * stream.
   * @param {*} reader 
   */
  extract(reader) {
    const document = new OleCompoundDoc(reader);
    return document.read()
      .then(() =>
        this.documentStream(document, 'WordDocument')
          .then((stream) => this.streamBuffer(stream))
          .then((buffer) => this.extractWordDocument(document, buffer))
      );
  }

  /**
   * Builds and returns a {@link Document} object corresponding to the text
   * in the original document. This involves reading and retrieving the text
   * ranges corresponding to the primary document parts. The text segments are
   * read from the extracted table of text pieces.
   * @returns a {@link Document} object
   */
  buildDocument() {
    const document = new Document();
    const pieces = this._pieces;

    let start = 0;

    document._body = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpText));
    start += this._boundaries.ccpText;

    if (this._boundaries.ccpFtn) {
      document._footnotes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpFtn - 1));
      start += this._boundaries.ccpFtn;  
    }

    if (this._boundaries.ccpHdd) {
      // Replaced old single-block data with tagged selection. See #34
      // document._headers = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpHdd - 1));
      document._headers = clean(this._taggedHeaders.filter((s) => s.type === 'headers').map((s) => s.text).join(""));
      document._footers = clean(this._taggedHeaders.filter((s) => s.type === 'footers').map((s) => s.text).join(""));

      start += this._boundaries.ccpHdd;  
    }

    if (this._boundaries.ccpAtn) {
      document._annotations = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpAtn - 1));
      start += this._boundaries.ccpAtn;  
    }

    if (this._boundaries.ccpEdn) {
      document._endnotes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpEdn - 1));
      start += this._boundaries.ccpEdn;  
    }

    if (this._boundaries.ccpTxbx) {
      document._textboxes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpTxbx - 1));
      start += this._boundaries.ccpTxbx;  
    }

    if (this._boundaries.ccpHdrTxbx) {
      document._headerTextboxes = clean(getTextRangeByCP(pieces, start, start + this._boundaries.ccpHdrTxbx - 1));
      start += this._boundaries.ccpHdrTxbx;  
    }

    return document;
  }

  /**
   * Main logic top level function for unpacking a Word document 
   * @param {*} document the OLE document
   * @param {*} buffer a buffer 
   * @returns a Promise which resolves to a {@link Document}
   */
  extractWordDocument(document, buffer) {
    const magic = buffer.readUInt16LE(0);
    if (magic !== 0xa5ec) {
      return Promise.reject(new Error(`This does not seem to be a Word document: Invalid magic number: ${magic.toString(16)}`));
    }

    const flags = buffer.readUInt16LE(0xA);

    const streamName = (flags & 0x0200) !== 0 ? "1Table" : "0Table";

    return this.documentStream(document, streamName)
      .then((stream) => this.streamBuffer(stream))
      .then((streamBuffer) => {
        this._boundaries.fcMin = buffer.readUInt32LE(0x0018);
        this._boundaries.ccpText = buffer.readUInt32LE(0x004c);
        this._boundaries.ccpFtn = buffer.readUInt32LE(0x0050);
        this._boundaries.ccpHdd = buffer.readUInt32LE(0x0054);
        this._boundaries.ccpAtn = buffer.readUInt32LE(0x005c);
        this._boundaries.ccpEdn = buffer.readUInt32LE(0x0060);
        this._boundaries.ccpTxbx = buffer.readUInt32LE(0x0064);
        this._boundaries.ccpHdrTxbx = buffer.readUInt32LE(0x0068);

        this.writeBookmarks(buffer, streamBuffer);
        this.writePieces(buffer, streamBuffer);
        this.writeCharacterProperties(buffer, streamBuffer);
        this.writeParagraphProperties(buffer, streamBuffer);
        this.normalizeHeaders(buffer, streamBuffer);

        return this.buildDocument();
      });
  }

  /**
   * Returns a promise that resolves to the named stream.
   * @param {*} document 
   * @param {*} streamName 
   * @returns a promise that resolves to the named stream
   */
  documentStream(document, streamName) {
    return Promise.resolve(document.stream(streamName));
  }

  /**
   * Returns a promise that resolves to a Buffer containing the contents of 
   * the given stream. 
   * @param {*} stream 
   * @returns a promise that resolves to the sream contents
   */
  streamBuffer(stream) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('error', (error) => reject(error));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      return stream;
    });
  }

  writeFields(buffer, tableBuffer, result) {    // eslint-disable-line no-unused-vars
    const fcPlcffldMom = buffer.readInt32LE(0x011a);
    const lcbPlcffldMom = buffer.readUInt32LE(0x011e);
    //console.log(fcPlcffldMom, lcbPlcffldMom, tableBuffer.length);

    if (lcbPlcffldMom == 0) {
      return;
    }

    const fieldCount = (lcbPlcffldMom - 4) / 6;
    //console.log("extracting", fieldCount, "fields");

    const dataOffset = (fieldCount + 1) * 4;

    const plcffldMom = tableBuffer.slice(fcPlcffldMom, fcPlcffldMom + lcbPlcffldMom);
    for(let i = 0; i < fieldCount; i++) {
      const cp = plcffldMom.readUInt32LE(i * 4);      // eslint-disable-line no-unused-vars
      const fld = plcffldMom.readUInt16LE(dataOffset + i * 2);
      const byte1 = fld & 0xff;
      const byte2 = fld >> 8;                         // eslint-disable-line no-unused-vars
      if ((byte1 & 0x1f) == 19) {
        //console.log("A", i, cp, byte1.toString(16), byte2.toString(16));
      } else {
        //console.log("B", i, cp, byte1.toString(16), byte2.toString(16));
      }
    }
  }

  /**
   * Extracts and stores the document bookmarks into a local field.
   * @param {*} buffer 
   * @param {*} tableBuffer 
   */
  writeBookmarks(buffer, tableBuffer) {
    const fcSttbfBkmk = buffer.readUInt32LE(0x0142);
    const lcbSttbfBkmk = buffer.readUInt32LE(0x0146);
    const fcPlcfBkf = buffer.readUInt32LE(0x014a);
    const lcbPlcfBkf = buffer.readUInt32LE(0x014e);
    const fcPlcfBkl = buffer.readUInt32LE(0x0152);
    const lcbPlcfBkl = buffer.readUInt32LE(0x0156);

    if (lcbSttbfBkmk === 0) { 
      return; 
    }

    const sttbfBkmk = tableBuffer.slice(fcSttbfBkmk, fcSttbfBkmk + lcbSttbfBkmk);
    const plcfBkf = tableBuffer.slice(fcPlcfBkf, fcPlcfBkf + lcbPlcfBkf);
    const plcfBkl = tableBuffer.slice(fcPlcfBkl, fcPlcfBkl + lcbPlcfBkl);

    const fcExtend = sttbfBkmk.readUInt16LE(0);
    const cData = sttbfBkmk.readUInt16LE(2);       // eslint-disable-line no-unused-vars
    const cbExtra = sttbfBkmk.readUInt16LE(4);     // eslint-disable-line no-unused-vars

    if (fcExtend !== 0xffff) {
      throw new Error("Internal error: unexpected single-byte bookmark data");
    }

    let offset = 6;
    const index = 0;

    while (offset < lcbSttbfBkmk) {
      let length = sttbfBkmk.readUInt16LE(offset);
      length = length * 2;
      const segment = sttbfBkmk.slice(offset + 2, offset + 2 + length);
      const cpStart = plcfBkf.readUInt32LE(index * 4);
      const cpEnd = plcfBkl.readUInt32LE(index * 4);
      this._bookmarks[segment] = {start: cpStart, end: cpEnd};
      offset = offset + length + 2;
    }
  }

  /**
   * Extracts and stores the document text pieces into a local field. This is
   * probably the most crucial part of text extraction, as it is where we
   * get text corresponding to character positions. These may be stored in a 
   * different order in the file compared to the order we want them. 
   * 
   * @param {*} buffer 
   * @param {*} tableBuffer 
   */
  writePieces(buffer, tableBuffer) {
    let flag;
    let pos = buffer.readUInt32LE(0x01a2);

    while (true) {                          // eslint-disable-line no-constant-condition
      flag = tableBuffer.readUInt8(pos);
      if (flag !== 1) { break; }

      pos = pos + 1;
      const skip = tableBuffer.readUInt16LE(pos);
      pos = pos + 2 + skip;
    }

    flag = tableBuffer.readUInt8(pos);
    pos = pos + 1;
    if (flag !== 2) {
      throw new Error("Internal error: ccorrupted Word file");
    }

    const pieceTableSize = tableBuffer.readUInt32LE(pos);
    pos = pos + 4;

    const pieces = (pieceTableSize - 4) / 12;

    let startCp = 0;
    let startStream = 0;

    for (let x = 0, end = pieces - 1; x <= end; x++) {
      const offset = pos + ((pieces + 1) * 4) + (x * 8) + 2;
      let startFilePos = tableBuffer.readUInt32LE(offset);
      let unicode = false;
      if ((startFilePos & 0x40000000) === 0) {
        unicode = true;
      } else {
        startFilePos = startFilePos & ~(0x40000000);
        startFilePos = Math.floor(startFilePos / 2);
      }
      const lStart = tableBuffer.readUInt32LE(pos + (x * 4));
      const lEnd = tableBuffer.readUInt32LE(pos + ((x + 1) * 4));
      const totLength = lEnd - lStart;

      const piece = {
        startCp,
        startStream,
        totLength,
        startFilePos,
        unicode,
        bpc: (unicode) ? 2 : 1
      };

      piece.size = piece.bpc * (lEnd - lStart); 

      const textBuffer = buffer.slice(startFilePos, startFilePos + piece.size);
      if (unicode) {
        piece.text = textBuffer.toString('ucs2');
      } else {
        piece.text = binaryToUnicode(textBuffer.toString('binary'));
      }
      
      piece.length = piece.text.length;

      piece.endCp = piece.startCp + piece.length;
      piece.endStream = piece.startStream + piece.size;
      piece.endFilePos = piece.startFilePos + piece.size;

      startCp = piece.endCp;
      startStream = piece.endStream;

      this._pieces.push(piece);
    }
  }

  /**
   * Processes the headers and footers. The main logic here is that we might have a mix 
   * of "real" and "pseudo" headers. For example, a footnote generates some footnote
   * separator footer elements, which, unless they contain something interesting, we 
   * can dispense with. In fact, we want to dispense with anything which is made up of
   * whitespace and control characters, in general. This means locating the segments of
   * text in the extracted pieces, and conditionally replacing them with nulls. 
   * 
   * @param {*} buffer 
   * @param {*} tableBuffer 
   */
  normalizeHeaders(buffer, tableBuffer) {
    const pieces = this._pieces;
    
    const fcPlcfhdd = buffer.readUInt32LE(0x00f2);
    const lcbPlcfhdd = buffer.readUInt32LE(0x00f6);
    if (lcbPlcfhdd < 8) {
      return;
    }

    const offset = this._boundaries.ccpText + this._boundaries.ccpFtn;
    const ccpHdd = this._boundaries.ccpHdd;

    const plcHdd = tableBuffer.slice(fcPlcfhdd, fcPlcfhdd + lcbPlcfhdd);
    const plcHddCount = (lcbPlcfhdd / 4);
    let start = offset + plcHdd.readUInt32LE(0);
    for(let i = 1; i < plcHddCount; i++) {
      let end = offset + plcHdd.readUInt32LE(i * 4);
      if (end > offset + ccpHdd) { 
        end = offset + ccpHdd; 
      }
      const string = getTextRangeByCP(pieces, start, end);
      const story = i - 1;
      if ([0, 1, 2].includes(story)) {
        this._taggedHeaders.push({type: 'footnoteSeparators', text: string});
      } else if ([3, 4, 5].includes(story)) {
        this._taggedHeaders.push({type: 'endSeparators', text: string});
      } else if ([0, 1, 4].includes(story % 6)) {
        this._taggedHeaders.push({type: 'headers', text: string});
      } else if ([2, 3, 5].includes(story % 6)) {
        this._taggedHeaders.push({type: 'footers', text: string});
      }

      if (! /[^\r\n\u0002-\u0008]/.test(string)) {
        replaceSelectedRange(pieces, start, end, "\x00");
      } else {
        replaceSelectedRange(pieces, end - 1, end, "\x00");
      }

      start = end;     // eslint-disable-line no-unused-vars
    }

    // The last character can always be dropped, but we handle that later anyways. 
  }

  writeParagraphProperties(buffer, tableBuffer) {
    const pieces = this._pieces;

    const fcPlcfbtePapx = buffer.readUInt32LE(0x0102);
    const lcbPlcfbtePapx = buffer.readUInt32LE(0x0106);

    const plcBtePapxCount = (lcbPlcfbtePapx - 4) / 8;
    const dataOffset = (plcBtePapxCount + 1) * 4;
    const plcBtePapx = tableBuffer.slice(fcPlcfbtePapx, fcPlcfbtePapx + lcbPlcfbtePapx);

    for(let i = 0; i < plcBtePapxCount; i++) {
      const cp = plcBtePapx.readUInt32LE(i * 4);    // eslint-disable-line no-unused-vars
      const papxFkpBlock = plcBtePapx.readUInt32LE(dataOffset + i * 4);
      //console.log("paragraph property", cp, papxFkpBlock);

      const papxFkpBlockBuffer = buffer.slice(papxFkpBlock * 512, (papxFkpBlock + 1) * 512);
      //console.log("papxFkpBlockBuffer", papxFkpBlockBuffer);

      const crun = papxFkpBlockBuffer.readUInt8(511);
      //console.log("crun", crun);

      for(let j = 0; j < crun; j++) {
        const rgfc = papxFkpBlockBuffer.readUInt32LE(j * 4);
        const rgfcNext = papxFkpBlockBuffer.readUInt32LE((j + 1) * 4);

        const cbLocation = (crun + 1) * 4 + j * 13;
        const cbIndex = papxFkpBlockBuffer.readUInt8(cbLocation) * 2;

        const cb = papxFkpBlockBuffer.readUInt8(cbIndex);
        let grpPrlAndIstd = null;
        if (cb !== 0) {
          grpPrlAndIstd = papxFkpBlockBuffer.slice(cbIndex + 1, cbIndex + 1 + (2 * cb) - 1);
        } else {
          const cb2 = papxFkpBlockBuffer.readUInt8(cbIndex + 1);
          grpPrlAndIstd = papxFkpBlockBuffer.slice(cbIndex + 2, cbIndex + 2 + (2 * cb2));
        }
        //console.log("para; ", j, "rgfc=", rgfc, "rgfcNext=", rgfcNext, "grpPrlAndIstd=", grpPrlAndIstd);

        const istd = grpPrlAndIstd.readUInt16LE(0);    // eslint-disable-line no-unused-vars
        processSprms(grpPrlAndIstd, 2, (buffer, offset, sprm, ispmd, fspec, sgc, spra) => {    // eslint-disable-line no-unused-vars
          //console.log("sprm x", offset, sprm.toString(16), ispmd, fspec, sgc, spra);
          if (sprm === 0x2417) {
            replaceSelectedRangeByFilePos(pieces, rgfc, rgfcNext, '\n');
          }
        });
      }
      
    }
  }

  writeCharacterProperties(buffer, tableBuffer) {
    const pieces = this._pieces;

    const fcPlcfbteChpx = buffer.readUInt32LE(0x00fa);
    const lcbPlcfbteChpx = buffer.readUInt32LE(0x00fe);

    const plcBteChpxCount = (lcbPlcfbteChpx - 4) / 8;
    //console.log("character format runs", plcBteChpxCount, fcPlcfbteChpx, lcbPlcfbteChpx);

    const dataOffset = (plcBteChpxCount + 1) * 4;
    const plcBteChpx = tableBuffer.slice(fcPlcfbteChpx, fcPlcfbteChpx + lcbPlcfbteChpx);

    //const cpLast = plcBteChpx.readUInt32LE(plcBteChpxCount * 4);
    //console.log("last cp", cpLast);

    let lastDeletionEnd = null;

    for(let i = 0; i < plcBteChpxCount; i++) {
      const cp = plcBteChpx.readUInt32LE(i * 4);    // eslint-disable-line no-unused-vars
      const chpxFkpBlock = plcBteChpx.readUInt32LE(dataOffset + i * 4);
      //console.log("character property", cp, chpxFkpBlock);

      const chpxFkpBlockBuffer = buffer.slice(chpxFkpBlock * 512, (chpxFkpBlock + 1) * 512);
      //console.log("chpxFkpBlockBuffer", chpxFkpBlockBuffer);

      const crun = chpxFkpBlockBuffer.readUInt8(511);
      //console.log("crun", crun);

      for(let j = 0; j < crun; j++) {
        const rgfc = chpxFkpBlockBuffer.readUInt32LE(j * 4);
        const rgfcNext = chpxFkpBlockBuffer.readUInt32LE((j + 1) * 4);
        const rgb = chpxFkpBlockBuffer.readUInt8((crun + 1) * 4 + j);
        if (rgb == 0) {
          //console.log("skipping run; ", j, "rgfc=", rgfc, "rgb=", rgb);
          continue;
        }
        const chpxOffset = rgb * 2;
        const cb = chpxFkpBlockBuffer.readUInt8(chpxOffset);
        const grpprl = chpxFkpBlockBuffer.slice(chpxOffset + 1, chpxOffset + 1 + cb);
        //console.log("found run; ", j, "rgfc=", rgfc, "rgb=", rgb, "cb=", cb, "grpprl=", grpprl);

        processSprms(grpprl, 0, (buffer, offset, sprm, ispmd) => {
          if (ispmd === sprmCFRMarkDel) {
            if ((buffer[offset] & 1) != 1) {
              return;
            }

            // console.log("text deleted", rgfc, rgfcNext);
            if (lastDeletionEnd === rgfc) {
              markDeletedRange(pieces, lastDeletionEnd, rgfcNext);
            } else {
              markDeletedRange(pieces, rgfc, rgfcNext);
            }
            lastDeletionEnd = rgfcNext;

            // if (ld >= 0 && this._deletions[ld].end === rgfc) {
            //   this._deletions[ld].end = rgfcNext;
            // } else {
            //   this._deletions.push({start: rgfc, end: rgfcNext});
            // }
          }
        });
      }
    }
  }

}

module.exports = WordOleExtractor;

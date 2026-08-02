/**
 * @module filters
 * 
 * @description
 * Exports several functions that implement various methods for translating
 * characters into Unicode, and cleaning up some of the remaining residues from
 * Word's odd internal marker character usage.
 */

/**
 * A replacement table, that maps Word control characters to either NULL, for
 * deletion, or to another more acceptable character ina Unicode world, such 
 * as a newline.
 */
const replaceTable = [];
replaceTable[0x0002] = '\x00';
replaceTable[0x0005] = '\x00';
replaceTable[0x0007] = "\t";
replaceTable[0x0008] = '\x00';
replaceTable[0x000A] = "\n";
replaceTable[0x000B] = "\n";
replaceTable[0x000C] = "\n";
replaceTable[0x000D] = "\n";
replaceTable[0x001E] = "\u2011";

/**
 * @constant
 * Maps between Windows character codes, especially between 0x80 and 0x9f,
 * into official Unicode code points. This smooths over the differences
 * between UCS-2 and 8-bit code runs in Word, by allowing us to work
 * entirely within Unicode later on.
 */
const binaryToUnicodeTable = [];
binaryToUnicodeTable[0x0082] = "\u201a";
binaryToUnicodeTable[0x0083] = "\u0192";
binaryToUnicodeTable[0x0084] = "\u201e";
binaryToUnicodeTable[0x0085] = "\u2026";
binaryToUnicodeTable[0x0086] = "\u2020";
binaryToUnicodeTable[0x0087] = "\u2021";
binaryToUnicodeTable[0x0088] = "\u02C6";
binaryToUnicodeTable[0x0089] = "\u2030";
binaryToUnicodeTable[0x008a] = "\u0160";
binaryToUnicodeTable[0x008b] = "\u2039";
binaryToUnicodeTable[0x008c] = "\u0152";
binaryToUnicodeTable[0x008e] = "\u017D";
binaryToUnicodeTable[0x0091] = "\u2018";
binaryToUnicodeTable[0x0092] = "\u2019";
binaryToUnicodeTable[0x0093] = "\u201C";
binaryToUnicodeTable[0x0094] = "\u201D";
binaryToUnicodeTable[0x0095] = "\u2022";
binaryToUnicodeTable[0x0096] = "\u2013";
binaryToUnicodeTable[0x0097] = "\u2014";
binaryToUnicodeTable[0x0098] = "\u02DC";
binaryToUnicodeTable[0x0099] = "\u2122";
binaryToUnicodeTable[0x009a] = "\u0161";
binaryToUnicodeTable[0x009b] = "\u203A";
binaryToUnicodeTable[0x009c] = "\u0153";
binaryToUnicodeTable[0x009e] = "\u017E";
binaryToUnicodeTable[0x009f] = "\u0178";

/**
 * Converts character codes from 0x80 to 0x9f to Unicode equivalents
 * within a string
 * @param {string} string - the input string
 * @returns a converted string
 */
module.exports.binaryToUnicode = (string) => {
  return string.replace(/([\x80-\x9f])/g, (match) => binaryToUnicodeTable[match.charCodeAt(0)]);
};

/**
 * The main function for cleaning OLE-based text. It runs a few standard replacements on characters
 * that are reserved for special purposes, also removes fields, and finally strips out any weird 
 * characters that are likely not to be useful for anyone.
 * 
 * @param {string} string - an input string
 * @returns a cleaned up string
 */
module.exports.clean = (string) => {

  // Fields can be nested, which makes this awkward. We use a strict non-nesting model
  // and repeat until we find no substitutions. This is because a second match might
  // start before an earlier one, due to our replacements.

  string = string.replace(/([\x02\x05\x07\x08\x0a\x0b\x0c\x0d\x1f])/g, (match) => replaceTable[match.charCodeAt(0)]);

  let called = true;
  while (called) {
    called = false;
    string = string.replace(/(?:\x13[^\x13\x14\x15]*\x14?([^\x13\x14\x15]*)\x15)/g, (match, p1) => { called = true; return p1; });
  }

  return string
    .replace(/[\x00-\x07]/g, '');
};

const filterTable = [];
filterTable[0x2002] = " ";
filterTable[0x2003] = " ";
filterTable[0x2012] = "-";
filterTable[0x2013] = "-";
filterTable[0x2014] = "-";
filterTable[0x2018] = "'";
filterTable[0x2019] = "'";
filterTable[0x201c] = "\"";
filterTable[0x201d] = "\"";

/**
 * Filters a string, with a few common Unicode replacements, primarily for standard
 * punctuation like non-breaking spaces, hyphens, and left and right curly quotes.
 * @param {string} string - the input string
 * @returns a filtered string
 */
module.exports.filter = (string) => {
  return string
    .replace(/[\u2002\u2003\u2012\u2013\u2014\u2018\u2019\u201c\u201d]/g, (match) => filterTable[match.charCodeAt(0)]);
};

/**
 * @module document
 * 
 * @description
 * Implements the main document returned when a Word file has been extracted. This exposes
 * methods that allow the body, annotations, headers, footnotes, and endnotes, to be 
 * read and used.
 * 
 * @author
 * Stuart Watt <stuart@morungos.com>
 */

const { filter } = require('./filters');

/**
 * @class
 * Returned from all extractors, this class provides accessors to read the different
 * parts of a Word document. This also allows some options to be passed to the accessors,
 * so you can control some character conversion and filtering, as described in the methods
 * below.
 */
class Document {
  
  constructor() {
    this._body = "";
    this._footnotes = "";
    this._endnotes = "";
    this._headers = "";
    this._footers = "";
    this._annotations = "";
    this._textboxes = "";
    this._headerTextboxes = "";
  }

  /**
   * Accessor to read the main body part of a Word file
   * @param {Object} options - options for body data
   * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
   *   to standard ASCII characters 
   * @returns a string, containing the Word file body
   */
  getBody(options) {
    options = options || {};
    const value = this._body;
    return (options.filterUnicode == false) ? value : filter(value);
  }

  /**
   * Accessor to read the footnotes part of a Word file
   * @param {Object} options - options for body data
   * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
   *   to standard ASCII characters 
   * @returns a string, containing the Word file footnotes
   */
  getFootnotes(options) {
    options = options || {};
    const value = this._footnotes;
    return (options.filterUnicode == false) ? value : filter(value);
  }

  /**
   * Accessor to read the endnotes part of a Word file
   * @param {Object} options - options for body data
   * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
   *   to standard ASCII characters 
   * @returns a string, containing the Word file endnotes
   */
  getEndnotes(options) {
    options = options || {};
    const value = this._endnotes;
    return (options.filterUnicode == false) ? value : filter(value);
  }

  /**
   * Accessor to read the headers part of a Word file
   * @param {Object} options - options for body data
   * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
   *   to standard ASCII characters 
   * @param {boolean} options.includeFooters - if true (the default), returns headers and footers 
   *   as a single string
   * @returns a string, containing the Word file headers
   */
  getHeaders(options) {
    options = options || {};
    const value = this._headers + ((options.includeFooters == false) ? "" : this._footers);
    return (options.filterUnicode == false) ? value : filter(value);
  }

  /**
   * Accessor to read the footers part of a Word file
   * @param {Object} options - options for body data
   * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
   *   to standard ASCII characters 
   * @returns a string, containing the Word file footers
   */
  getFooters(options) {
    options = options || {};
    const value = this._footers;
    return (options.filterUnicode == false) ? value : filter(value);
  }

  /**
   * Accessor to read the annotations part of a Word file
   * @param {Object} options - options for body data
   * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
   *   to standard ASCII characters 
   * @returns a string, containing the Word file annotations
   */
  getAnnotations(options) {
    options = options || {};
    const value = this._annotations;
    return (options.filterUnicode == false) ? value : filter(value);
  }

  /**
   * Accessor to read the textboxes from a Word file. The text box content is aggregated as a 
   * single long string. When both the body and header content exists, they will be separated
   * by a newline.
   * @param {Object} options - options for body data
   * @param {boolean} options.filterUnicode - if true (the default), converts common Unicode quotes
   *   to standard ASCII characters 
   * @param {boolean} options.includeHeadersAndFooters - if true (the default), includes text box
   *   content in headers and footers
   * @param {boolean} options.includeBody - if true (the default), includes text box
   *   content in the document body
   * @returns a string, containing the Word file text box content
   */
  getTextboxes(options) {
    options = options || {};
    const segments = [];
    if (options.includeBody != false) 
      segments.push(this._textboxes);
    if (options.includeHeadersAndFooters != false)
      segments.push(this._headerTextboxes);
    const value = segments.join("\n");
    return (options.filterUnicode == false) ? value : filter(value);
  }
}


module.exports = Document;

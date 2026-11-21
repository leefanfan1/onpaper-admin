/**
 * The commit history re-exported from its own module.
 *
 * `history` and `audit` are two views of one question, so they live in one file;
 * this keeps the routes' imports reading as the pages they render.
 */
export { HistoryView } from './audit'

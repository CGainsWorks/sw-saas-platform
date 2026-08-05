/**
 * Types and validation schemas shared between the API and the web front end.
 *
 * This package is the single source of truth for the wire format. The API validates
 * inbound bodies with these schemas; the web client uses the inferred types for its
 * typed fetch wrapper. If the two ever disagree, it is a compile error rather than a
 * runtime surprise.
 */
export * from './domain.js';
export * from './dto.js';
export * from './errors.js';

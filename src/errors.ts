/** Base class for every error this package raises on purpose. */
export class DocsearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The caller asked for something the request cannot support. */
export class BadRequestError extends DocsearchError {}

/** A required setting is missing or malformed. */
export class ConfigError extends DocsearchError {}

/** An embedding backend answered with something unusable. */
export class EmbeddingError extends DocsearchError {}

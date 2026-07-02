/**
 * An error carrying an HTTP status code. Thrown from the store/service layer
 * and translated into a JSON response by the error-handling middleware.
 */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

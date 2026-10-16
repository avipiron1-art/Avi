export class AppError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (msg, extra) => new AppError(400, msg, extra);
export const unauthorized = (msg = 'יש להתחבר למערכת') => new AppError(401, msg);
export const forbidden = (msg = 'אין לך הרשאה לבצע פעולה זו') => new AppError(403, msg);
export const notFound = (msg = 'הפריט המבוקש לא נמצא') => new AppError(404, msg);
export const conflict = (msg, extra) => new AppError(409, msg, extra);

/** Wrap async/sync route handlers so thrown errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) {
    next(e);
  }
};

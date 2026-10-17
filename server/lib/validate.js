import { z } from 'zod';
import { badRequest } from './errors.js';

// Hebrew error messages for common zod issues
z.setErrorMap((issue, ctx) => {
  switch (issue.code) {
    case 'invalid_type':
      return { message: issue.received === 'undefined' || issue.received === 'null' ? 'שדה חובה' : 'ערך לא תקין' };
    case 'too_small':
      return { message: issue.type === 'string' ? (issue.minimum <= 1 ? 'שדה חובה' : `יש להזין לפחות ${issue.minimum} תווים`) : `הערך המינימלי הוא ${issue.minimum}` };
    case 'too_big':
      return { message: issue.type === 'string' ? `ניתן להזין עד ${issue.maximum} תווים` : `הערך המקסימלי הוא ${issue.maximum}` };
    case 'invalid_string':
      return { message: issue.validation === 'email' ? 'כתובת אימייל לא תקינה' : 'פורמט לא תקין' };
    case 'invalid_enum_value':
      return { message: 'ערך לא תקין' };
    default:
      return { message: ctx.defaultError };
  }
});

/** Parse data with schema; throw a 400 with per-field errors on failure. */
export function validate(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields = {};
    for (const i of r.error.issues) {
      const k = i.path.join('.') || '_';
      if (!fields[k]) fields[k] = i.message;
    }
    throw badRequest('יש לתקן את השדות המסומנים', { fields });
  }
  return r.data;
}

// Reusable primitives
const trimmed = (max) => z.string().trim().max(max);
export const zText = (max = 200) => trimmed(max).min(1);
export const zOptText = (max = 2000) =>
  z.union([trimmed(max), z.null()]).optional().transform((v) => (v === '' || v == null ? null : v));
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'תאריך לא תקין')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'תאריך לא תקין');
/** 'YYYY-MM'; callers default a missing month to the current one. */
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'חודש לא תקין').optional();
export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'שעה לא תקינה');
export const zDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'מועד לא תקין');
export const zId = z.coerce.number().int().positive();
export const zOptId = z.union([z.coerce.number().int().positive(), z.null(), z.literal('')]).optional()
  .transform((v) => (v === '' || v == null ? null : v));
export const zEmail = z.string().trim().toLowerCase().email().max(120);
export const zPhone = z.string().trim().regex(/^[0-9+\-\s()]{7,20}$/, 'מספר טלפון לא תקין');
export const zAvatar = z.union([
  z.string().max(400_000, 'התמונה גדולה מדי (עד 300KB)')
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'קובץ תמונה לא נתמך'),
  z.null(),
]).optional();
export const zPassword = z.string().min(8, 'הסיסמה חייבת להכיל לפחות 8 תווים').max(100)
  .regex(/[A-Za-z]/, 'הסיסמה חייבת להכיל לפחות אות אחת באנגלית')
  .regex(/\d/, 'הסיסמה חייבת להכיל לפחות ספרה אחת');

/** Parse an integer id from route params or throw 400. */
export function paramId(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('מזהה לא תקין');
  return n;
}

export { z };

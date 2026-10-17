import { Router } from 'express';
import { ah, badRequest } from '../lib/errors.js';
import { validate, z, zDate } from '../lib/validate.js';
import { addDays } from '../lib/time.js';
import { holidaysBetween } from '../services/holidays.js';

const router = Router();
router.get('/holidays', ah((req, res) => {
  const { from, to } = validate(z.object({ from: zDate, to: zDate }), req.query);
  if (addDays(from, 400) < to) throw badRequest('טווח ארוך מדי');
  res.json({ holidays: holidaysBetween(from, to) });
}));
export default router;

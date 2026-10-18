// Responsibility scopes (must match server/services/scope.js)
export const SCOPES = [
  { key: 'all', label: 'כל הרשת', hint: 'למשל מנהל ראשי או מנהל תפעול – כל הסניפים וכל העובדים' },
  { key: 'branch', label: 'הסניף שלו', hint: 'מנהל סניף – כל העובדים בסניף שלו' },
  { key: 'branches', label: 'סניפים שבוחרים', hint: 'מנהל אזור – בוחרים לכל משתמש את הסניפים שבאחריותו' },
  { key: 'department', label: 'המחלקה שלו בסניף שלו', hint: 'מנהל מחלקה – למשל "מנהל מטבח – סניף חיפה"' },
  { key: 'department_all', label: 'המחלקה שלו בכל הסניפים', hint: 'למשל "שף ראשי של הרשת"' },
  { key: 'lead', label: 'רק במשמרות שבהן הוא אחמ"ש', hint: 'ההרשאות פועלות רק בזמן המשמרת, ורק על העובדים שבה' },
  { key: 'self', label: 'רק על עצמו', hint: 'עובד רגיל' },
];
export const scopeLabel = (key) => SCOPES.find((s) => s.key === key)?.label || '';

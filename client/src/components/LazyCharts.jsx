// Charts are the heaviest part of the app; load them only when a chart is on screen.
import { Suspense, lazy } from 'react';

const load = () => import('./Charts.jsx');
const pick = (name) => lazy(() => load().then((m) => ({ default: m[name] })));
const Bar = pick('HoursBar');
const Area = pick('HoursArea');
const Stacked = pick('StackedBar');
const wrap = (C) => function LazyChart(props) {
  return <Suspense fallback={<div className="chart-box skeleton" aria-hidden="true" />}><C {...props} /></Suspense>;
};

export const HoursBar = wrap(Bar);
export const HoursArea = wrap(Area);
export const StackedBar = wrap(Stacked);

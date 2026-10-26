// The Vite library entry. Importing the stylesheet here rather than in
// `index.ts` keeps the side-effect import out of the emitted declarations.
import './css/index.scss';

export * from './index.ts';

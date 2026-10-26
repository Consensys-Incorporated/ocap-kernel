/// <reference types="vite/client" />

import 'ses';
import '@endo/eventual-send/shim.js';

const isTest = import.meta?.env?.MODE === 'test';

lockdown({
  consoleTaming: 'unsafe',
  errorTaming: isTest ? 'unsafe-debug' : 'unsafe',
  overrideTaming: 'severe',
  domainTaming: 'unsafe',
  stackFiltering: isTest ? 'verbose' : 'concise',
});

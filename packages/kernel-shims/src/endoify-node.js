/* global hardenIntrinsics */

// Node.js-specific endoify that imports modules which modify globals before lockdown.
// This file is copied (not bundled) to dist/ during build.

import './endoify-repair.js';

// @libp2p/webrtc needs to modify globals in Node.js only, so we need to import
// it before hardening.
import '@libp2p/webrtc';

hardenIntrinsics();

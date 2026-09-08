import type { NextRequest } from 'next/server';
import { parseReadingRequest, problemResponse } from './server/reading/http.ts';

// Syntax guard only, before Next decodes dynamic route params. Without this, malformed
// percent escapes throw in the router before our handler and incorrectly become 500.
// It never creates context, grants access or rewrites a reference. Handlers validate again.
export function proxy(request: NextRequest) {
  if (!parseReadingRequest(request)) return problemResponse(400);
}

export const config = { matcher: '/api/v1/material/:path*' };

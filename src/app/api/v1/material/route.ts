import { handleReadingRequest } from '@/server/reading/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) { return handleReadingRequest(request); }
export const HEAD = GET;
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const OPTIONS = GET;

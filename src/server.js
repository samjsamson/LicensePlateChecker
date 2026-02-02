const path = require('path');
const fastify = require('fastify');
const { fetch } = require('undici');

const app = fastify({ logger: true });
const PORT = process.env.PORT || 3000;
const DMV_START_URL = 'https://www.dmv.ca.gov/wasapp/ipp2/startPers.do';
const DMV_URL = 'https://www.dmv.ca.gov/wasapp/ipp2/checkPers.do';
const DEBUG_DMV = process.env.DEBUG_DMV === 'true';
const CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const plateCache = new Map();
const requestBuckets = new Map();

class ValidationError extends Error {}

function extractCookieHeader(setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) {
    return '';
  }

  return setCookieHeaders
    .map((cookie) => String(cookie).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function fetchDmvCookie() {
  const res = await fetch(DMV_START_URL, {
    method: 'GET',
    signal: AbortSignal.timeout(10000)
  });

  const setCookieHeaders = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return extractCookieHeader(setCookieHeaders);
}

function getClientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return request.ip || 'unknown';
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = requestBuckets.get(ip);

  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    requestBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }

  if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  bucket.count += 1;
  return false;
}

function getCachedResult(plate) {
  const entry = plateCache.get(plate);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    plateCache.delete(plate);
    return null;
  }

  return entry.result;
}

function setCachedResult(plate, result) {
  plateCache.set(plate, {
    result,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
}

function normalizePlate(input) {
  if (typeof input !== 'string') {
    throw new ValidationError('Plate must be text.');
  }

  const normalized = input.trim().toUpperCase();

  if (normalized.length === 0) {
    throw new ValidationError('Plate cannot be empty.');
  }

  if (normalized.length < 2 || normalized.length > 7) {
    throw new ValidationError('Plates must be between 2 and 7 characters.');
  }

  if (!/^[A-Z0-9/ ]+$/.test(normalized)) {
    throw new ValidationError('Only letters A-Z, digits 0-9, spaces, and "/" are allowed.');
  }

  return normalized;
}

function buildPlateForm(plate) {
  const formData = new URLSearchParams({
    plateType: 'Z',
    kidsPlate: '',
    plateNameLow: 'california 1960s legacy',
    plateName: 'California 1960s Legacy',
    plateLength: String(plate.length),
    vetDecalCd: '',
    centeredPlateLength: '0',
    platechecked: 'no',
    imageSelected: 'none',
    vehicleType: 'AUTO',
    vetDecalDesc: ''
  });

  for (let i = 0; i < 14; i++) {
    formData.append(`plateChar${i}`, plate[i] || '');
  }

  return formData;
}

function interpretDmvResponse(payload, httpStatus) {
  if (httpStatus >= 500) {
    return { status: 'unavailable', message: 'DMV service is temporarily unavailable. Please try again shortly.' };
  }

  if (payload === null || payload === undefined) {
    return { status: 'unavailable', message: 'Unexpected response from DMV service.' };
  }

  if (typeof payload === 'string') {
    const text = payload.toLowerCase();
    if (text.includes('can be requested') || text.includes('available')) {
      return { status: 'available', message: 'That plate is available.' };
    }
    if (text.includes('not available') || text.includes('already in use') || text.includes('unavailable')) {
      return { status: 'taken', message: 'That plate appears to be taken.' };
    }
    return { status: 'unavailable', message: 'Could not interpret DMV response. Please try again.' };
  }

  const code = String(payload.code || payload.status || payload.result || '').toUpperCase();
  const message = payload.message || payload.errorMessage || payload.statusMessage;
  const normalizedMessage = typeof message === 'string' ? message.trim().toLowerCase() : '';
  const messageMap = {
    'message.available': { status: 'available', message: 'That plate is available.' },
    'message.notavailable': { status: 'taken', message: 'That plate appears to be taken.' },
    'message.taken': { status: 'taken', message: 'That plate appears to be taken.' },
    'message.invalid': { status: 'invalid', message: 'That plate is invalid.' },
    'message.global': { status: 'unavailable', message: 'DMV returned a temporary error. Please try again.' }
  };

  if (messageMap[normalizedMessage]) {
    return messageMap[normalizedMessage];
  }

  if (payload.success === true && code === 'AVAILABLE') {
    return { status: 'available', message: 'That plate is available.' };
  }

  if (payload.available === true || code === 'AVAILABLE' || code === 'SUCCESS') {
    return { status: 'available', message: message || 'That plate is available.' };
  }

  if (
    code === 'VALIDATION' ||
    code === 'INVALID' ||
    payload.isValid === false
  ) {
    return { status: 'invalid', message: message || 'That plate is invalid.' };
  }

  if (
    code === 'TAKEN' ||
    code === 'UNAVAILABLE' ||
    code === 'NOT_AVAILABLE' ||
    payload.available === false
  ) {
    return { status: 'taken', message: message || 'That plate appears to be taken.' };
  }

  if (typeof message === 'string' && message.length > 0 && !normalizedMessage.startsWith('message.')) {
    return { status: 'taken', message };
  }

  return { status: 'unavailable', message: 'Could not interpret DMV response. Please try again.' };
}

function getPayloadSnippet(payload) {
  if (typeof payload === 'string') {
    return payload.slice(0, 500);
  }

  try {
    return JSON.stringify(payload).slice(0, 500);
  } catch {
    return String(payload).slice(0, 500);
  }
}

app.register(require('@fastify/cors'), {
  origin: true,
  methods: ['POST', 'GET']
});

app.register(require('@fastify/static'), {
  root: path.join(__dirname, '../public'),
  prefix: '/',
  decorateReply: false
});

app.post('/api/check-plate', async (request, reply) => {
  try {
    const clientIp = getClientIp(request);
    if (isRateLimited(clientIp)) {
      return reply.status(429).send({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    const { plate } = request.body || {};

    if (plate === undefined || plate === null) {
      return reply.status(400).send({ error: 'Missing plate value.' });
    }

    const normalized = normalizePlate(plate);
    const cached = getCachedResult(normalized);
    if (cached) {
      return reply.send({ ...cached, cached: true });
    }

    const formData = buildPlateForm(normalized);
    const cookieHeader = await fetchDmvCookie();

    const res = await fetch(DMV_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (compatible; PlateChecker/1.0; +https://platechecker.org)',
        Referer: DMV_START_URL,
        Origin: 'https://www.dmv.ca.gov',
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      body: formData.toString(),
      signal: AbortSignal.timeout(10000)
    });

    let payload;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      payload = await res.json();
    } else {
      const text = await res.text();
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    const interpreted = interpretDmvResponse(payload, res.status);
    if (interpreted.status === 'unavailable') {
      if (DEBUG_DMV) {
        app.log.warn(
          {
            dmvStatus: res.status,
            dmvContentType: contentType,
            dmvPayloadSnippet: getPayloadSnippet(payload)
          },
          'DMV response could not be interpreted'
        );
      }
      return reply.status(502).send({ error: interpreted.message });
    }

    setCachedResult(normalized, interpreted);
    return reply.send({ ...interpreted, cached: false });
  } catch (err) {
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: err.message });
    }

    app.log.error('DMV request failed', err);
    return reply.status(502).send({ error: 'Unable to reach DMV endpoint.', details: err.message });
  }
});

const start = async () => {
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    app.log.info(`Server listening on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

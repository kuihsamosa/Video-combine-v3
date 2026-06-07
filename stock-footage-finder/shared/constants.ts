// Constants for the stock footage finder application

export const MEDIA_SOURCES = [
  {
    name: 'pexels',
    displayName: 'Pexels',
    baseUrl: 'https://api.pexels.com',
    apiKeyRequired: true,
  },
  {
    name: 'pixabay',
    displayName: 'Pixabay',
    baseUrl: 'https://pixabay.com/api/',
    apiKeyRequired: true,
  },
  {
    name: 'unsplash',
    displayName: 'Unsplash',
    baseUrl: 'https://api.unsplash.com',
    apiKeyRequired: true,
  },
  {
    name: 'videvo',
    displayName: 'Videvo',
    baseUrl: 'https://www.videvo.net/api',
    apiKeyRequired: true,
  },
  {
    name: 'coverr',
    displayName: 'Coverr',
    baseUrl: 'https://api.coverr.co',
    apiKeyRequired: false,
  },
];

export const DEFAULT_SETTINGS = {
  defaultSources: ['pexels', 'pixabay', 'unsplash'],
  defaultPerPage: 20,
  maxPerPage: 100,
};

export const API_ENDPOINTS = {
  backend: 'http://localhost:8000',
  search: '/api/search',
  apiKeys: '/api/keys',
  health: '/health',
};

export const SUPPORTED_MEDIA_TYPES = {
  video: 'video',
  image: 'image',
  all: 'all',
} as const;

export const SUPPORTED_ORIENTATIONS = {
  landscape: 'landscape',
  portrait: 'portrait',
  all: 'all',
} as const;
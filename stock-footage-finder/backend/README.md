# Stock Footage Finder Backend API

This is the backend API for the Stock Footage Finder application, which provides a unified interface to search across multiple stock media sources.

## Features

- Search across multiple stock media sources (Pexels, Pixabay, Unsplash, Videvo, Coverr)
- API key management with encryption
- Rate limiting and quota tracking
- Standardized response format across all sources
- Error handling and retry logic
- Support for both videos and images

## Installation

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

3. Add your API keys to the `.env` file:
```
PEXELS_API_KEY=your_pexels_api_key_here
PIXABAY_API_KEY=your_pixabay_api_key_here
UNSPLASH_API_KEY=your_unsplash_api_key_here
VIDEVO_API_KEY=your_videvo_api_key_here
COVERR_API_KEY=your_coverr_api_key_here
```

## Running the Server

```bash
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The API will be available at `http://localhost:8000`

## API Documentation

Once the server is running, you can access the interactive API documentation at:
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

## API Endpoints

### Search Endpoints

- `GET /api/search` - Search across all sources
- `GET /api/sources/{source}/search` - Search a specific source
- `GET /api/sources/{source}/popular` - Get popular media from a source

### API Key Management

- `GET /api/keys` - Get all API keys (masked) and usage stats
- `POST /api/keys` - Add or update an API key
- `DELETE /api/keys/{source}` - Remove an API key
- `POST /api/keys/test` - Test an API key
- `GET /api/keys/{source}/test` - Test an existing API key
- `GET /api/keys/{source}/usage` - Get usage statistics for a source

### Configuration

- `GET /api/sources` - Get all available sources and their configurations
- `GET /api/config` - Get current application configuration

## Usage Examples

### Search across all sources
```bash
curl "http://localhost:8000/api/search?query=nature&per_page=10"
```

### Search a specific source
```bash
curl "http://localhost:8000/api/sources/pexels/search?query=ocean&per_page=5"
```

### Add an API key
```bash
curl -X POST "http://localhost:8000/api/keys" \
  -H "Content-Type: application/json" \
  -d '{"source": "pexels", "api_key": "your_api_key_here"}'
```

### Get usage statistics
```bash
curl "http://localhost:8000/api/keys/pexels/usage"
```

## Architecture

The backend is organized into the following modules:

- `config.py` - Configuration management and settings
- `services/api_key_manager.py` - API key encryption, storage, and usage tracking
- `services/stock_media_service.py` - Media search functionality for all sources
- `api/endpoints.py` - FastAPI endpoints and request/response models
- `main.py` - FastAPI application setup and configuration

## Security

- API keys are encrypted using Fernet symmetric encryption
- API keys are masked in responses for security
- Rate limiting prevents API quota exhaustion
- CORS is configured for frontend integration

## Rate Limiting

Each source has its own rate limit:
- Pexels: 200 requests/hour
- Pixabay: 100 requests/hour
- Unsplash: 50 requests/hour
- Videvo: 100 requests/hour
- Coverr: 100 requests/hour

The API tracks usage and will automatically stop making requests to a source when its rate limit is reached.
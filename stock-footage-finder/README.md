# Stock Footage Finder

A serverless stock footage finder that allows users to search multiple stock media sources (Pexels, Pixabay, Unsplash, Videvo, Coverr), preview media before downloading, manage API keys in one interface, and download selected media.

## Project Structure

```
stock-footage-finder/
├── frontend/          # React + TypeScript frontend (Vite)
├── backend/           # FastAPI Python backend
├── shared/            # Shared types and constants
└── package.json       # Root package.json with scripts
```

## Getting Started

### Prerequisites

- Node.js (v18+)
- Python (v3.8+)
- npm or yarn

### Installation

1. Clone the repository and navigate to the project directory
2. Install all dependencies:
   ```bash
   npm run install:all
   ```

### API Keys

1. Copy the backend environment file:
   ```bash
   cp backend/.env.example backend/.env
   ```

2. Fill in your API keys in `backend/.env`:
   - Pexels API Key: https://www.pexels.com/api/
   - Pixabay API Key: https://pixabay.com/api/docs/
   - Unsplash API Key: https://unsplash.com/developers
   - Videvo API Key: https://www.videvo.net/api/
   - Coverr API Key: https://coverr.co/api (optional)

### Running the Application

1. Start both frontend and backend:
   ```bash
   npm run dev
   ```

2. Or start them individually:
   ```bash
   # Frontend only (runs on http://localhost:5173)
   npm run dev:frontend
   
   # Backend only (runs on http://localhost:8000)
   npm run dev:backend
   ```

### Building for Production

```bash
npm run build
```

## Features

- Search multiple stock media sources from one interface
- Preview media before downloading
- Manage API keys in one place
- Download selected media
- Responsive design
- TypeScript support for type safety

## Technology Stack

### Frontend
- React 18
- TypeScript
- Vite
- Tailwind CSS (to be added)

### Backend
- FastAPI
- Python
- Uvicorn
- Pydantic

## License

MIT
// Media types for the stock footage finder application

export interface MediaItem {
  id: string;
  title: string;
  description?: string;
  url: string;
  previewUrl?: string;
  downloadUrl?: string;
  duration?: number; // in seconds for videos
  width?: number;
  height?: number;
  fileSize?: number;
  tags?: string[];
  source: MediaSource;
  license?: string;
  author?: string;
  authorUrl?: string;
}

export interface MediaSource {
  name: string;
  displayName: string;
  baseUrl: string;
  apiKeyRequired: boolean;
}

export interface SearchResult {
  source: string;
  query: string;
  results: MediaItem[];
  totalCount?: number;
  page?: number;
  perPage?: number;
}

export interface SearchParams {
  query: string;
  sources: string[];
  perPage?: number;
  page?: number;
  mediaType?: 'video' | 'image' | 'all';
  orientation?: 'landscape' | 'portrait' | 'all';
}

export interface ApiKeys {
  pexels?: string;
  pixabay?: string;
  unsplash?: string;
  videvo?: string;
  coverr?: string;
}

export interface AppSettings {
  apiKeys: ApiKeys;
  defaultSources: string[];
  defaultPerPage: number;
}

// Download-related types
export interface Download {
  id: string;
  media_id: string;
  media_url: string;
  media_title: string;
  media_source: string;
  media_type: 'video' | 'image';
  filename: string;
  file_path?: string;
  file_size?: number;
  mime_type?: string;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  total_bytes?: number;
  downloaded_bytes: number;
  download_speed?: number;
  eta_seconds?: number;
  retry_count: number;
  max_retries: number;
  error_message?: string;
  error_code?: string;
  created_at: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string;
}

export interface DownloadHistory {
  id: string;
  download_id: string;
  action: string;
  message?: string;
  progress_at_time?: number;
  speed_at_time?: number;
  created_at: string;
}

export interface DownloadRequest {
  media_id: string;
  media_url: string;
  media_title: string;
  media_source: string;
  media_type: 'video' | 'image';
}

export interface DownloadListResponse {
  downloads: Download[];
  total: number;
  page: number;
  per_page: number;
}

export interface DownloadStats {
  total_downloads: number;
  completed_downloads: number;
  failed_downloads: number;
  active_downloads: number;
  paused_downloads: number;
  total_bytes_downloaded: number;
  success_rate: number;
}
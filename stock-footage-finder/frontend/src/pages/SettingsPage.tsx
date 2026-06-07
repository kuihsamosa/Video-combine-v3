import React, { useState, useRef, useEffect } from 'react';
import { ArrowLeft, Download, Upload, Trash2, Check, AlertCircle } from 'lucide-react';
import { useThemeContext } from '../contexts/ThemeContext';
import { useApiKeyManager, getSourceDisplayName } from '../hooks/useApiKeyManager';
import { storageService } from '../services/storageService';
import ApiKeyManager from '../components/ApiKeyManager';
import { DEFAULT_SETTINGS } from '../../../shared/constants';
import type { AppSettings } from '../types';

export default function SettingsPage() {
  const { theme, toggleTheme, isDark } = useThemeContext();
  const {
    apiKeys,
    isLoading,
    error,
    isDirty,
    saveApiKey,
    removeApiKey,
    clearAllApiKeys,
    resetForm,
    hasUnsavedChanges,
  } = useApiKeyManager();

  const [activeTab, setActiveTab] = useState<'api-keys' | 'preferences' | 'data'>('api-keys');
  const [exportData, setExportData] = useState('');
  const [importData, setImportData] = useState('');
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [isClearingData, setIsClearingData] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleExportData = () => {
    const data = storageService.exportData();
    setExportData(data);
    setShowExportDialog(true);
  };

  const handleImportData = () => {
    if (!importData.trim()) {
      setImportResult({ success: false, message: 'Please provide JSON data to import.' });
      return;
    }

    try {
      const result = storageService.importData(importData);
      setImportResult(result);
      
      if (result.success) {
        setImportData('');
        setShowImportDialog(false);
        setActionMessage({ type: 'success', message: 'Data imported successfully.' });
      } else {
        setActionMessage({ type: 'error', message: result.message || 'Import failed.' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Import failed';
      setImportResult({ success: false, message });
      setActionMessage({ type: 'error', message });
    }
  };

  const handleImportFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      setImportData(text);
      setImportResult(null);
      setActionMessage({ type: 'success', message: `Loaded ${file.name}. Review the data, then click Import.` });
    } catch (error) {
      setActionMessage({ type: 'error', message: 'Failed to read the selected file.' });
    } finally {
      event.target.value = '';
    }
  };

  const handleClearAllData = () => {
    setShowClearDialog(true);
  };

  const confirmClearAllData = async () => {
    try {
      setIsClearingData(true);
      storageService.clearAllData();
      setActionMessage({ type: 'success', message: 'All data has been cleared.' });
    } catch (error) {
      setActionMessage({ type: 'error', message: 'Failed to clear data. Please try again.' });
    } finally {
      setIsClearingData(false);
      setShowClearDialog(false);
    }
  };

  useEffect(() => {
    if (!actionMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setActionMessage(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [actionMessage]);

  const handleDownloadExport = () => {
    const blob = new Blob([exportData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stock-footage-finder-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setShowExportDialog(false);
    setActionMessage({ type: 'success', message: 'Export file downloaded successfully.' });
  };

  const renderApiKeysTab = () => (
    <div className="settings-page__tab-content">
      <div className="settings-page__section">
        <h2 className="settings-page__section-title">
          API Key Management
        </h2>
        <p className="settings-page__section-description">
          Configure API keys to access premium stock media sources. Your keys are stored securely and used only for making API requests.
        </p>
        
        <ApiKeyManager onSave={() => {/* Refresh data */}} />
      </div>
    </div>
  );

  const handleManageDefaultSources = () => {
    // TODO: implement default source management dialog
  };

  const renderPreferencesTab = () => (
    <div className="settings-page__tab-content">
      <div className="settings-page__section">
        <div className="settings-page__section-header">
          <h2 className="settings-page__section-title">Appearance</h2>
          <p className="settings-page__section-description">
            Personalize how the interface looks and feels across the application.
          </p>
        </div>

        <div className="settings-page__setting">
          <div className="settings-page__setting-info">
            <label className="settings-page__setting-label">Theme</label>
            <p className="settings-page__setting-description">
              Switch between light and dark themes to match your workspace.
            </p>
          </div>
          <div className="settings-page__setting-control">
            <button
              onClick={toggleTheme}
              className="settings-page__theme-toggle"
            >
              {isDark ? (
                <>
                  <span className="settings-page__theme-icon settings-page__theme-icon--light">☀️</span>
                  <span>Light Mode</span>
                </>
              ) : (
                <>
                  <span className="settings-page__theme-icon settings-page__theme-icon--dark">🌙</span>
                  <span>Dark Mode</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="settings-page__section">
        <div className="settings-page__section-header">
          <h2 className="settings-page__section-title">Search Preferences</h2>
          <p className="settings-page__section-description">
            Control which providers are selected by default and how many results appear per page.
          </p>
        </div>
        
        <div className="settings-page__setting">
          <div className="settings-page__setting-info">
            <label className="settings-page__setting-label">Default Sources</label>
            <p className="settings-page__setting-description">
              These providers are pre-selected whenever you start a new search.
            </p>
          </div>
          <div className="settings-page__setting-control settings-page__setting-control--stacked">
            <div className="settings-page__source-list">
              {DEFAULT_SETTINGS.defaultSources.map(source => (
                <button
                  key={source}
                  type="button"
                  className="settings-page__source-chip"
                  onClick={handleManageDefaultSources}
                >
                  {getSourceDisplayName(source)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="settings-page__link-button"
              onClick={handleManageDefaultSources}
            >
              Manage default sources
            </button>
          </div>
        </div>

        <div className="settings-page__setting">
          <div className="settings-page__setting-info">
            <label className="settings-page__setting-label">Results Per Page</label>
            <p className="settings-page__setting-description">
              Choose how many results should be shown at a time in each search.
            </p>
          </div>
          <div className="settings-page__setting-control">
            <select className="settings-page__select">
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );

  const renderDataTab = () => (
    <div className="settings-page__tab-content">
      <div className="settings-page__section">
        <h2 className="settings-page__section-title">
          Data Management
        </h2>
        <p className="settings-page__section-description">
          Export your search history and favorites, or import data from a backup.
        </p>
        
        <div className="settings-page__data-actions">
          <button
            onClick={handleExportData}
            className="settings-page__data-button settings-page__data-button--primary"
          >
            <Download size={16} />
            Export Data
          </button>
          
          <button
            onClick={() => setShowImportDialog(true)}
            className="settings-page__data-button settings-page__data-button--ghost"
          >
            <Upload size={16} />
            Import Data
          </button>
          
          <button
            onClick={handleClearAllData}
            className="settings-page__data-button settings-page__data-button--danger"
          >
            <Trash2 size={16} />
            Clear All Data
          </button>
        </div>

        {actionMessage && (
          <div className={`settings-page__action-feedback settings-page__action-feedback--${actionMessage.type}`}>
            {actionMessage.type === 'success' ? <Check size={18} /> : <AlertCircle size={18} />}
            <span>{actionMessage.message}</span>
            <button
              type="button"
              className="settings-page__action-feedback-close"
              onClick={() => setActionMessage(null)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );

  const renderExportDialog = () => {
    if (!showExportDialog) return null;

    return (
      <div className="settings-page__dialog-overlay">
        <div className="settings-page__dialog">
          <div className="settings-page__dialog-header">
            <h3>Export Data</h3>
            <button
              onClick={() => setShowExportDialog(false)}
              className="settings-page__dialog-close"
            >
              ×
            </button>
          </div>
          
          <div className="settings-page__dialog-content">
            <p>Your data is ready to export:</p>
            <pre className="settings-page__export-preview">
              {exportData.substring(0, 200)}...
            </pre>
          </div>
          
          <div className="settings-page__dialog-actions">
            <button
              onClick={handleDownloadExport}
              className="settings-page__dialog-button settings-page__dialog-button--primary"
            >
              <Download size={16} />
              Download
            </button>
            <button
              onClick={() => setShowExportDialog(false)}
              className="settings-page__dialog-button"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderImportDialog = () => {
    if (!showImportDialog) return null;

    return (
      <div className="settings-page__dialog-overlay">
        <div className="settings-page__dialog">
          <div className="settings-page__dialog-header">
            <h3>Import Data</h3>
            <button
              onClick={() => {
                setShowImportDialog(false);
                setImportResult(null);
              }}
              className="settings-page__dialog-close"
            >
              ×
            </button>
          </div>
          
          <div className="settings-page__dialog-content">
            <p>Upload a previously exported JSON backup or paste its contents below:</p>
            <div className="settings-page__import-actions">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json"
                onChange={handleImportFileChange}
                className="settings-page__file-input"
              />
              <button
                type="button"
                className="settings-page__dialog-button settings-page__dialog-button--ghost"
                onClick={handleImportFileClick}
              >
                <Upload size={16} /> Upload JSON
              </button>
            </div>
            <textarea
              value={importData}
              onChange={(e) => setImportData(e.target.value)}
              className="settings-page__import-textarea"
              placeholder="Paste your JSON data here..."
              rows={10}
            />
            
            {importResult && (
              <div className={`settings-page__import-result ${importResult.success ? 'settings-page__import-result--success' : 'settings-page__import-result--error'}`}>
                {importResult.success ? (
                  <Check size={16} />
                ) : (
                  <AlertCircle size={16} />
                )}
                <span>{importResult.message}</span>
              </div>
            )}
          </div>
          
          <div className="settings-page__dialog-actions">
            <button
              onClick={handleImportData}
              className="settings-page__dialog-button settings-page__dialog-button--primary"
              disabled={!importData.trim()}
            >
              <Upload size={16} />
              Import
            </button>
            <button
              onClick={() => {
                setShowImportDialog(false);
                setImportResult(null);
              }}
              className="settings-page__dialog-button"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderClearDialog = () => {
    if (!showClearDialog) return null;

    return (
      <div className="settings-page__dialog-overlay">
        <div className="settings-page__dialog">
          <div className="settings-page__dialog-header">
            <h3>Clear All Data</h3>
            <button
              onClick={() => {
                setShowClearDialog(false);
                setIsClearingData(false);
              }}
              className="settings-page__dialog-close"
            >
              ×
            </button>
          </div>
          
          <div className="settings-page__dialog-content">
            <p>This will permanently delete your search history, favorites, and saved API keys from this device.</p>
            <p className="settings-page__danger-text">This action cannot be undone.</p>
          </div>
          
          <div className="settings-page__dialog-actions">
            <button
              onClick={confirmClearAllData}
              className="settings-page__dialog-button settings-page__dialog-button--danger"
              disabled={isClearingData}
            >
              {isClearingData ? 'Clearing…' : 'Clear Everything'}
            </button>
            <button
              onClick={() => {
                setShowClearDialog(false);
                setIsClearingData(false);
              }}
              className="settings-page__dialog-button"
              disabled={isClearingData}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="settings-page">
      {/* Header */}
      <header className="settings-page__header">
        <div className="settings-page__header-content">
          <a href="/" className="settings-page__back-button">
            <ArrowLeft size={20} />
            Back
          </a>
          
          <h1 className="settings-page__title">Settings</h1>
        </div>
      </header>

      {/* Navigation */}
      <nav className="settings-page__nav">
        <button
          onClick={() => setActiveTab('api-keys')}
          className={`settings-page__nav-button ${activeTab === 'api-keys' ? 'settings-page__nav-button--active' : ''}`}
        >
          API Keys
          {Object.keys(apiKeys).length > 0 && (
            <span className="settings-page__nav-badge">
              {Object.keys(apiKeys).length}
            </span>
          )}
        </button>
        
        <button
          onClick={() => setActiveTab('preferences')}
          className={`settings-page__nav-button ${activeTab === 'preferences' ? 'settings-page__nav-button--active' : ''}`}
        >
          Preferences
        </button>
        
        <button
          onClick={() => setActiveTab('data')}
          className={`settings-page__nav-button ${activeTab === 'data' ? 'settings-page__nav-button--active' : ''}`}
        >
          Data Management
        </button>
      </nav>

      {/* Tab Content */}
      <main className="settings-page__main">
        {activeTab === 'api-keys' && renderApiKeysTab()}
        {activeTab === 'preferences' && renderPreferencesTab()}
        {activeTab === 'data' && renderDataTab()}
      </main>

      {/* Dialogs */}
      {renderExportDialog()}
      {renderImportDialog()}
      {renderClearDialog()}
    </div>
  );
}
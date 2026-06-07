import React from 'react';
import { ArrowLeft, Github, ExternalLink, Heart, Shield, Zap, Search, KeyRound, Sparkles, CheckCircle2 } from 'lucide-react';
import { useThemeContext } from '../contexts/ThemeContext';
import { MEDIA_SOURCES } from '../../../shared/constants';

export default function AboutPage() {
  const { isDark } = useThemeContext();

  const features = [
    {
      icon: <Search size={24} />,
      title: 'Multi-Source Search',
      description: 'Search across multiple stock media sources simultaneously to find the perfect content for your projects.',
      accent: 'primary',
    },
    {
      icon: <Shield size={24} />,
      title: 'Secure API Key Management',
      description: 'Your API keys are stored securely and used only for making requests to stock media services.',
      accent: 'security',
    },
    {
      icon: <Heart size={24} />,
      title: 'Favorites & History',
      description: 'Save your favorite media items and access your search history across sessions.',
      accent: 'favorite',
    },
    {
      icon: <Zap size={24} />,
      title: 'Fast Downloads',
      description: 'Download media directly from sources with progress tracking and resume support.',
      accent: 'energy',
    },
  ];

  const supportedSources = MEDIA_SOURCES.map(source => ({
    name: source.displayName,
    free: !source.apiKeyRequired,
    description: source.apiKeyRequired 
      ? 'Requires API key to access premium content.'
      : 'Free access available – start searching immediately.',
  }));

  const steps = [
    {
      title: 'Configure API Keys',
      description: 'Add your API keys for premium stock media services in the settings page.',
      icon: <KeyRound size={18} />,
    },
    {
      title: 'Search & Filter',
      description: 'Use powerful search with filters to find exactly what you need.',
      icon: <Sparkles size={18} />,
    },
    {
      title: 'Preview & Download',
      description: 'Preview media before downloading and get your files instantly.',
      icon: <Download size={18} />,
    },
  ];

  return (
    <div className="about-page">
      {/* Header */}
      <header className="about-page__header">
        <div className="about-page__header-content">
          <a href="/" className="about-page__back-button">
            <ArrowLeft size={20} />
            Back
          </a>
          
          <h1 className="about-page__title">About</h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="about-page__main">
        {/* Hero Section */}
        <section className="about-page__hero">
          <div className="about-page__hero-content">
            <h2 className="about-page__hero-title">
              Stock Footage Finder
            </h2>
            <p className="about-page__hero-description">
              A powerful web application that helps you search, discover, and download high-quality stock footage and images from multiple sources in one place.
            </p>
            
            <div className="about-page__hero-stats">
              <div className="about-page__stat">
                <span className="about-page__stat-number">
                  {MEDIA_SOURCES.length}
                </span>
                <span className="about-page__stat-label">
                  Supported Sources
                </span>
              </div>
              
              <div className="about-page__stat">
                <span className="about-page__stat-number">
                  ∞
                </span>
                <span className="about-page__stat-label">
                  Unlimited Searches
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section className="about-page__section">
          <h2 className="about-page__section-title">Features</h2>
          <div className="about-page__features">
            {features.map((feature, index) => (
              <div key={index} className={`about-page__feature about-page__feature--${feature.accent}`}>
                <div className="about-page__feature-icon">
                  {feature.icon}
                </div>
                <h3 className="about-page__feature-title">
                  {feature.title}
                </h3>
                <p className="about-page__feature-description">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Supported Sources */}
        <section className="about-page__section">
          <h2 className="about-page__section-title">Supported Sources</h2>
          <div className="about-page__sources">
            {supportedSources.map((source, index) => (
              <div key={index} className="about-page__source">
                <div className="about-page__source-header">
                  <h3 className="about-page__source-name">
                    {source.name}
                  </h3>
                  <span
                    className={`about-page__source-badge ${source.free ? 'about-page__source-badge--free' : 'about-page__source-badge--premium'}`}
                  >
                    {source.free ? 'Free Access' : 'API Key Required'}
                  </span>
                </div>
                <p className="about-page__source-description">
                  {source.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* How It Works */}
        <section className="about-page__section">
          <h2 className="about-page__section-title">How It Works</h2>
          <div className="about-page__steps">
            {steps.map((step, index) => (
              <div key={index} className="about-page__step">
                <div className="about-page__step-number">
                  {index + 1}
                </div>
                <div className="about-page__step-icon" aria-hidden>
                  {step.icon}
                </div>
                <h3 className="about-page__step-title">{step.title}</h3>
                <p className="about-page__step-description">{step.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Privacy & Security */}
        <section className="about-page__section">
          <h2 className="about-page__section-title">Privacy & Security</h2>
          <div className="about-page__privacy">
            <div className="about-page__privacy-item">
              <Shield size={20} />
              <div>
                <h3>Local Storage</h3>
                <p>Your API keys and data are stored locally in your browser and never sent to third-party servers.</p>
              </div>
            </div>
            
            <div className="about-page__privacy-item">
              <Shield size={20} />
              <div>
                <h3>Secure Connections</h3>
                <p>All API requests are made over HTTPS to ensure secure communication with stock media services.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Open Source */}
        <section className="about-page__section">
          <h2 className="about-page__section-title">Open Source</h2>
          <div className="about-page__opensource">
            <p className="about-page__opensource-description">
              Stock Footage Finder is an open-source project built with modern web technologies. 
              You can contribute, report issues, or fork the project on GitHub.
            </p>
            
            <div className="about-page__opensource-actions">
              <a
                href="https://github.com/your-username/stock-footage-finder"
                target="_blank"
                rel="noopener noreferrer"
                className="about-page__opensource-button"
              >
                <Github size={20} />
                View on GitHub
              </a>
            </div>
          </div>
        </section>

        {/* Technologies */}
        <section className="about-page__section">
          <h2 className="about-page__section-title">Technologies</h2>
          <div className="about-page__tech">
            <div className="about-page__tech-category">
              <h3>Frontend</h3>
              <ul className="about-page__tech-list">
                <li>React 19</li>
                <li>TypeScript</li>
                <li>Vite</li>
                <li>Lucide Icons</li>
              </ul>
            </div>
            
            <div className="about-page__tech-category">
              <h3>Backend</h3>
              <ul className="about-page__tech-list">
                <li>Python</li>
                <li>FastAPI</li>
                <li>SQLite</li>
              </ul>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="about-page__footer">
        <p>
          Made with <Heart size={14} fill="currentColor" /> for the creative community
        </p>
        <p>
          © 2024 Stock Footage Finder. Version 1.0.0
        </p>
      </footer>
    </div>
  );
}
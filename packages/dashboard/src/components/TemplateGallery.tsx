import React, { useState, useEffect } from 'react';
import { useOllama } from '../hooks/useOllama';

interface Template {
  id: string;
  name: string;
  description: string;
  tags: string[];
  baseModel: string;
  useCase: string;
  content: string;
  downloads: number;
}

export function TemplateGallery() {
  const { apiCall, loading } = useOllama();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [filterTag, setFilterTag] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [createName, setCreateName] = useState('');
  const [createStatus, setCreateStatus] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    const res = await apiCall<{ templates: Template[] }>('/templates');
    if (res) setTemplates(res.templates);
  };

  const handleSearch = async () => {
    const params = searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : filterTag ? `?tag=${filterTag}` : '';
    const res = await apiCall<{ templates: Template[] }>(`/templates${params}`);
    if (res) setTemplates(res.templates);
  };

  const handleCreate = async () => {
    if (!selectedTemplate || !createName) return;
    setCreateStatus('Creating...');
    const res = await apiCall<{ success: boolean }>(`/templates/${selectedTemplate.id}/create`, {
      method: 'POST',
      body: JSON.stringify({ modelName: createName }),
    });
    setCreateStatus(res?.success ? 'Model created successfully!' : 'Creation failed');
    setTimeout(() => setCreateStatus(null), 3000);
  };

  const allTags = [...new Set(templates.flatMap((t) => t.tags))];

  return (
    <div className="bg-forge-card border border-forge-border rounded-xl p-6">
      <h2 className="text-lg font-semibold mb-4">Template Gallery</h2>

      {/* Search & Filter */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search templates..."
          className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm text-forge-text"
        />
        <button onClick={handleSearch} className="px-3 py-2 bg-forge-bg border border-forge-border rounded-lg text-sm text-forge-muted hover:text-forge-text transition-colors">
          Search
        </button>
      </div>

      {/* Tags */}
      <div className="flex flex-wrap gap-1 mb-4">
        <button
          onClick={() => { setFilterTag(''); handleSearch(); }}
          className={`text-xs px-2 py-1 rounded-full transition-colors ${!filterTag ? 'bg-forge-accent text-white' : 'bg-forge-bg text-forge-muted hover:text-forge-text'}`}
        >
          All
        </button>
        {allTags.map((tag) => (
          <button
            key={tag}
            onClick={() => { setFilterTag(tag); }}
            className={`text-xs px-2 py-1 rounded-full transition-colors ${filterTag === tag ? 'bg-forge-accent text-white' : 'bg-forge-bg text-forge-muted hover:text-forge-text'}`}
          >
            {tag}
          </button>
        ))}
      </div>

      {/* Template List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {templates
          .filter((t) => !filterTag || t.tags.includes(filterTag))
          .map((tmpl) => (
            <div
              key={tmpl.id}
              onClick={() => setSelectedTemplate(tmpl)}
              className={`p-4 rounded-lg cursor-pointer transition-all ${
                selectedTemplate?.id === tmpl.id
                  ? 'bg-forge-accent/20 border border-forge-accent'
                  : 'bg-forge-bg border border-transparent hover:border-forge-border'
              }`}
            >
              <div className="font-medium text-sm">{tmpl.name}</div>
              <div className="text-xs text-forge-muted mt-1 line-clamp-2">{tmpl.description}</div>
              <div className="flex gap-1 mt-2">
                {tmpl.tags.slice(0, 3).map((tag) => (
                  <span key={tag} className="text-xs px-1.5 py-0.5 bg-forge-border/50 rounded text-forge-muted">{tag}</span>
                ))}
              </div>
            </div>
          ))}
      </div>

      {/* Selected Template Preview */}
      {selectedTemplate && (
        <div className="border-t border-forge-border pt-4">
          <h3 className="text-sm font-medium mb-2">{selectedTemplate.name}</h3>
          <pre className="bg-forge-bg rounded-lg p-3 text-xs text-forge-text overflow-x-auto max-h-48 overflow-y-auto font-mono whitespace-pre-wrap">
            {selectedTemplate.content}
          </pre>
          <div className="flex gap-2 mt-3">
            <input
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="Model name (e.g. my-analyst)"
              className="flex-1 bg-forge-bg border border-forge-border rounded-lg px-3 py-2 text-sm text-forge-text"
            />
            <button
              onClick={handleCreate}
              disabled={!createName || loading}
              className="px-4 py-2 bg-forge-success text-white rounded-lg text-sm font-medium hover:bg-green-600 disabled:opacity-50 transition-colors"
            >
              Create Model
            </button>
          </div>
          {createStatus && (
            <div className={`mt-2 text-sm ${createStatus.includes('success') ? 'text-forge-success' : createStatus.includes('fail') ? 'text-forge-danger' : 'text-forge-muted'}`}>
              {createStatus}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

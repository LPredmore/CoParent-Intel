import React, { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import { chatWithAssistant } from '../services/ai';
import { AssistantSession, AssistantMessage, AssistantSenderType } from '../types';
import { Plus, Send, Paperclip, Bot, User, FileText, ArrowRight, Loader2, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { Link } from 'react-router-dom';

// Simple component to render bold text from "**text**" format
const FormattedText: React.FC<{ text: string }> = ({ text }) => {
  if (!text) return null;
  
  // Split by double asterisks
  const parts = text.split(/(\*\*.*?\*\*)/g);
  
  return (
    <span>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return <strong key={i} className="font-bold text-slate-900">{part.slice(2, -2)}</strong>;
        }
        return <span key={i} className="whitespace-pre-wrap">{part}</span>;
      })}
    </span>
  );
};

export const AssistantView: React.FC = () => {
  const [sessions, setSessions] = useState<AssistantSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [uploadingFile, setUploadingFile] = useState<File | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId);
    } else if (sessions.length > 0) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions, activeSessionId]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, sending]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [inputText]);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const data = await api.getAssistantSessions();
      setSessions(data);
      if (!activeSessionId && data.length > 0) {
        setActiveSessionId(data[0].id);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (sessionId: string) => {
    const msgs = await api.getAssistantMessages(sessionId);
    setMessages(msgs);
  };

  const handleNewSession = async () => {
    const newSession = await api.createAssistantSession();
    setSessions([newSession, ...sessions]);
    setActiveSessionId(newSession.id);
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    
    // Check if there is content to send and not currently sending
    // IMPORTANT: Do NOT check for activeSessionId here, as we create one if it's missing
    if ((!inputText.trim() && !uploadingFile) || sending) return;

    setSending(true);
    let targetSessionId = activeSessionId;

    try {
      // 1. If no active session (e.g. first time user), create one
      if (!targetSessionId) {
         try {
             const newSession = await api.createAssistantSession();
             setSessions(prev => [newSession, ...prev]);
             setActiveSessionId(newSession.id);
             targetSessionId = newSession.id;
         } catch (err) {
             console.error("Failed to create new session", err);
             setSending(false);
             return;
         }
      }

      const tempId = Math.random().toString();
      const contentToSend = inputText || (uploadingFile ? `Uploaded file: ${uploadingFile.name}` : '');
      
      // Optimistic User Message
      const userMsg: AssistantMessage = {
        id: tempId,
        sessionId: targetSessionId,
        senderType: AssistantSenderType.User,
        content: contentToSend,
        createdAt: new Date().toISOString()
      };
      
      setMessages(prev => [...prev, userMsg]);
      setInputText('');
      
      // Reset textarea height
      if (textareaRef.current) textareaRef.current.style.height = 'auto';

      // 2. Call AI Service
      await chatWithAssistant(targetSessionId, contentToSend, uploadingFile || undefined);
      
      // 3. Refresh Messages to get the AI response and the real user message
      const freshMessages = await api.getAssistantMessages(targetSessionId);
      setMessages(freshMessages);
      
      setUploadingFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';

    } catch (err) {
      console.error(err);
      // Fallback UI update for error
      setMessages(prev => [...prev, {
          id: Math.random().toString(),
          sessionId: targetSessionId || '',
          senderType: AssistantSenderType.System, // Using System or similar to indicate error
          content: "**Error:** Failed to process message. Please try again.",
          createdAt: new Date().toISOString()
      } as AssistantMessage]);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setUploadingFile(e.target.files[0]);
    }
  };

  return (
    <div className="flex h-[calc(100vh-6rem)] gap-6">
      {/* Sidebar Sessions */}
      <div className="w-64 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden shrink-0">
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
          <h3 className="font-bold text-slate-700 text-sm">History</h3>
          <button 
            onClick={handleNewSession}
            className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            title="New Session"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.map(session => (
            <button
              key={session.id}
              onClick={() => setActiveSessionId(session.id)}
              className={`w-full text-left p-4 border-b border-slate-50 hover:bg-slate-50 transition-colors ${
                activeSessionId === session.id ? 'bg-indigo-50 border-l-4 border-l-indigo-500' : 'border-l-4 border-l-transparent'
              }`}
            >
              <div className="font-medium text-slate-800 text-sm truncate">{session.title}</div>
              <div className="text-xs text-slate-400 mt-1">{format(new Date(session.lastActivityAt), 'MMM d, h:mm a')}</div>
            </button>
          ))}
          {sessions.length === 0 && !loading && (
             <div className="p-8 text-center text-slate-400 text-sm">No sessions yet.</div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Chat Header */}
        <div className="p-4 border-b border-slate-100 bg-slate-50 flex items-center gap-2">
           <Bot className="w-5 h-5 text-indigo-600" />
           <h2 className="font-bold text-slate-800">CoParent Assistant</h2>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/30">
          {messages.length === 0 ? (
             <div className="flex flex-col items-center justify-center h-full text-slate-400 opacity-60">
                <Bot className="w-16 h-16 mb-4" />
                <p>Start a new conversation or upload a document.</p>
                <div className="flex gap-2 mt-4 text-xs">
                   <span className="bg-slate-100 px-2 py-1 rounded">"Parse this OFW file"</span>
                   <span className="bg-slate-100 px-2 py-1 rounded">"Any issues with this email?"</span>
                </div>
             </div>
          ) : (
            messages.map((msg) => {
               const isUser = msg.senderType === AssistantSenderType.User;
               return (
                 <div key={msg.id} className={`flex gap-4 ${isUser ? 'flex-row-reverse' : ''}`}>
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${isUser ? 'bg-slate-200 text-slate-600' : 'bg-indigo-100 text-indigo-600'}`}>
                       {isUser ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5" />}
                    </div>
                    <div className={`flex flex-col max-w-[80%] ${isUser ? 'items-end' : 'items-start'}`}>
                       <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                          isUser ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none shadow-sm'
                       }`}>
                          <FormattedText text={msg.content} />
                       </div>
                       
                       {/* Link Action Card */}
                       {msg.linkedTargetType && msg.linkedTargetId && (
                         <div className="mt-2">
                            <Link 
                               to={`/${msg.linkedTargetType}s/${msg.linkedTargetId}`}
                               className="inline-flex items-center gap-2 bg-white border border-indigo-200 text-indigo-700 px-3 py-2 rounded-lg text-xs font-medium hover:bg-indigo-50 transition-colors shadow-sm"
                            >
                               View Related {msg.linkedTargetType === 'legal_document' ? 'Document' : msg.linkedTargetType.charAt(0).toUpperCase() + msg.linkedTargetType.slice(1)} <ArrowRight className="w-3 h-3" />
                            </Link>
                         </div>
                       )}
                       <span className="text-[10px] text-slate-400 mt-1">{format(new Date(msg.createdAt), 'h:mm a')}</span>
                    </div>
                 </div>
               );
            })
          )}
          {sending && (
             <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                   <Bot className="w-5 h-5 text-indigo-600 animate-pulse" />
                </div>
                <div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-tl-none shadow-sm">
                   <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                   <span className="text-xs text-slate-400 ml-2">Analyzing...</span>
                </div>
             </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 bg-white border-t border-slate-200">
           {uploadingFile && (
              <div className="flex items-center gap-2 mb-2 bg-slate-100 px-3 py-2 rounded-lg text-sm text-slate-700 w-fit border border-slate-200 shadow-sm">
                 <FileText className="w-4 h-4 text-indigo-600" />
                 <span className="truncate max-w-xs font-medium">{uploadingFile.name}</span>
                 <span className="text-xs text-slate-400">({(uploadingFile.size / 1024).toFixed(0)} KB)</span>
                 <button onClick={() => { setUploadingFile(null); if(fileInputRef.current) fileInputRef.current.value = ''; }} className="hover:text-red-500 ml-2 p-1">
                    <Trash2 className="w-4 h-4" />
                 </button>
              </div>
           )}
           <div className="flex gap-2 items-end">
              <input 
                 type="file" 
                 ref={fileInputRef}
                 className="hidden"
                 onChange={handleFileSelect}
              />
              <button 
                 type="button"
                 onClick={() => fileInputRef.current?.click()}
                 className={`p-3 rounded-lg transition-colors mb-0.5 ${uploadingFile ? 'text-indigo-600 bg-indigo-50 border border-indigo-100' : 'text-slate-400 hover:bg-slate-100 border border-transparent'}`}
                 title="Upload File"
              >
                 <Paperclip className="w-5 h-5" />
              </button>
              <textarea 
                 ref={textareaRef}
                 value={inputText}
                 onChange={e => setInputText(e.target.value)}
                 onKeyDown={handleKeyDown}
                 placeholder="Type a message or instruction..."
                 className="flex-1 bg-slate-50 border border-slate-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-indigo-500 outline-none text-sm resize-none min-h-[46px] max-h-48"
                 disabled={sending}
                 rows={1}
              />
              <button 
                 onClick={() => handleSendMessage()} 
                 disabled={(!inputText.trim() && !uploadingFile) || sending}
                 className="p-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm mb-0.5"
              >
                 <Send className="w-5 h-5" />
              </button>
           </div>
           <div className="text-[10px] text-slate-400 mt-2 text-center">
              AI acts as a GAL/Therapist. Verify important information independently.
           </div>
        </div>
      </div>
    </div>
  );
};

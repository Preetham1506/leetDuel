import React, { useState, useEffect } from 'react';
import { 
  Trophy, 
  User as UserIcon, 
  Play, 
  Gamepad2, 
  Search, 
  TrendingUp, 
  ShieldAlert, 
  LogOut,
  Target,
  Sparkles
} from 'lucide-react';

const useProductionAPI = import.meta.env.VITE_API_HOST;

const API_HOST = useProductionAPI 
  ? import.meta.env.VITE_API_HOST
  : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
      ? 'localhost:8000' 
      : `${window.location.hostname}:8000`);

const isSecure = window.location.protocol === 'https:' || (useProductionAPI && !import.meta.env.VITE_API_HOST.startsWith('localhost') && !import.meta.env.VITE_API_HOST.startsWith('127.0.0.1') && !import.meta.env.VITE_API_HOST.startsWith('192.168.'));
const HTTP_PROTOCOL = isSecure ? 'https' : 'http';
const WS_PROTOCOL = isSecure ? 'wss' : 'ws';

const API_BASE = `${HTTP_PROTOCOL}://${API_HOST}/api`;

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('leaderboard'); // leaderboard, lobby, auth
  
  // Auth Form states
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [authError, setAuthError] = useState('');

  // Leaderboard states
  const [leaderboard, setLeaderboard] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingLeaderboard, setLoadingLeaderboard] = useState(false);

  // Match / Lobby states
  const [topics, setTopics] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState('Arrays');
  const [activeMatch, setActiveMatch] = useState(null);
  const [matchHistory, setMatchHistory] = useState([]);
  const [lobbyError, setLobbyError] = useState('');
  const [isLobbyReady, setIsLobbyReady] = useState(false);
  const [lobbyWebSocket, setLobbyWebSocket] = useState(null);

  // Sync auth state
  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
      fetchCurrentUser();
    } else {
      localStorage.removeItem('token');
      setUser(null);
      if (activeTab === 'lobby') {
        setActiveTab('auth');
      }
    }
  }, [token]);

  // Load initial data
  useEffect(() => {
    fetchLeaderboard();
    fetchTopics();
  }, []);

  // Poll active match when in lobby
  useEffect(() => {
    let interval = null;
    if (token && activeTab === 'lobby' && !activeMatch) {
      fetchActiveMatch();
      fetchMatchHistory();
      interval = setInterval(() => {
        fetchActiveMatch();
      }, 5000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [token, activeTab, activeMatch]);

  // WebSocket sync for active lobby
  useEffect(() => {
    if (activeMatch && token && user) {
      const wsUrl = `${WS_PROTOCOL}://${API_HOST}/ws/match/${activeMatch.id}?user_id=${user.id}&token=${token}`;
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('Lobby WebSocket opened');
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log('Lobby message received:', data);
        if (data.type === 'LOBBY_STATE') {
          if (data.status === 'ABANDONED') {
            setActiveMatch(null);
            setIsLobbyReady(false);
            alert("The host has closed this lobby.");
            return;
          }
          // Update active match details with real-time ready states
          const hostPlayer = data.players.find(p => p.id === data.host_id);
          const guestPlayer = data.players.find(p => p.id === data.guest_id);
          
          setActiveMatch(prev => ({
            ...prev,
            players: data.players,
            status: data.status,
            host_id: data.host_id,
            guest_id: data.guest_id,
            striver_topic: data.topic,
            host: hostPlayer ? { id: hostPlayer.id, username: hostPlayer.username, elo_rating: hostPlayer.elo_rating } : prev?.host,
            guest: guestPlayer ? { id: guestPlayer.id, username: guestPlayer.username, elo_rating: guestPlayer.elo_rating } : null
          }));
          
          // Check our specific ready state
          const me = data.players.find(p => p.id === user.id);
          if (me) {
            setIsLobbyReady(me.is_ready);
          }
        } else if (data.type === 'START_MATCH') {
          // Match started! Send details to Chrome extension and redirect
          const matchPayload = {
            matchId: activeMatch.id,
            userId: user.id,
            token: token,
            username: user.username,
            questionUrl: data.question_url,
            questionTitle: data.question_title,
            apiHost: API_HOST,
            frontendHost: window.location.host
          };

          // Try to communicate with extension
          const EXTENSION_ID = document.documentElement.getAttribute('data-leetrace-extension-id') 
            || localStorage.getItem('leetrace_extension_id') 
            || 'iegmenkofabaecnbknolgnhhbopdnlil';
          if (window.chrome && chrome.runtime && chrome.runtime.sendMessage) {
            let redirected = false;
            
            // Safety timeout: redirect anyway after 1.5s if the extension does not respond (e.g. wrong Extension ID)
            const safetyTimeout = setTimeout(() => {
              if (!redirected) {
                redirected = true;
                console.warn("Chrome extension did not respond in time. Redirecting to LeetCode anyway...");
                window.location.href = data.question_url;
              }
            }, 1500);

            try {
              chrome.runtime.sendMessage(EXTENSION_ID, {
                type: 'SET_ACTIVE_MATCH',
                match: matchPayload
              }, (response) => {
                clearTimeout(safetyTimeout);
                if (!redirected) {
                  redirected = true;
                  console.log('Extension cache status:', response);
                  window.location.href = data.question_url;
                }
              });
            } catch (err) {
              clearTimeout(safetyTimeout);
              if (!redirected) {
                redirected = true;
                console.error("Failed to communicate with Chrome extension:", err);
                window.location.href = data.question_url;
              }
            }
          } else {
            // Fallback: alert details if extension is missing
            alert(`Match Starting! Please ensure your extension is loaded. Target URL: ${data.question_url}`);
            window.location.href = data.question_url;
          }
        }
      };

      ws.onclose = () => {
        console.log('Lobby WebSocket closed');
      };

      setLobbyWebSocket(ws);

      return () => {
        ws.close();
      };
    }
  }, [activeMatch?.id, token, user]);

  // --- API Functions ---

  const fetchCurrentUser = async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      } else {
        setToken('');
      }
    } catch {
      setToken('');
    }
  };

  const fetchLeaderboard = async () => {
    setLoadingLeaderboard(true);
    try {
      const res = await fetch(`${API_BASE}/leaderboard`);
      if (res.ok) {
        const data = await res.json();
        setLeaderboard(data);
      }
    } catch (e) {
      console.error("Failed to fetch leaderboard", e);
    } finally {
      setLoadingLeaderboard(false);
    }
  };

  const fetchTopics = async () => {
    try {
      const res = await fetch(`${API_BASE}/questions/topics`);
      if (res.ok) {
        const data = await res.json();
        setTopics(data);
        if (data.length > 0) setSelectedTopic(data[0]);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchActiveMatch = async () => {
    try {
      const res = await fetch(`${API_BASE}/matches/active`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setActiveMatch(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchMatchHistory = async () => {
    try {
      const res = await fetch(`${API_BASE}/matches/history`);
      if (res.ok) {
        const data = await res.json();
        setMatchHistory(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError('');
    const endpoint = isRegister ? '/auth/register' : '/auth/login';
    try {
      const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok) {
        if (isRegister) {
          // After register, automatically log in
          const loginRes = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
          const loginData = await loginRes.json();
          if (loginRes.ok) {
            setToken(loginData.access_token);
            setActiveTab('lobby');
          }
        } else {
          setToken(data.access_token);
          setActiveTab('lobby');
        }
        setUsername('');
        setPassword('');
      } else {
        setAuthError(data.detail || 'Authentication failed');
      }
    } catch {
      setAuthError('Server is currently unreachable');
    }
  };

  const handleCreateMatch = async () => {
    setLobbyError('');
    try {
      const res = await fetch(`${API_BASE}/matches/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ striver_topic: selectedTopic })
      });
      const data = await res.json();
      if (res.ok) {
        setActiveMatch(data);
      } else {
        setLobbyError(data.detail || 'Failed to create match');
      }
    } catch {
      setLobbyError('Could not connect to match server.');
    }
  };

  const handleJoinMatch = async (matchId) => {
    setLobbyError('');
    try {
      const res = await fetch(`${API_BASE}/matches/join/${matchId}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setActiveMatch(data);
      } else {
        setLobbyError(data.detail || 'Failed to join match');
      }
    } catch {
      setLobbyError('Failed to join the match room.');
    }
  };

  const toggleReadyState = () => {
    if (lobbyWebSocket && lobbyWebSocket.readyState === WebSocket.OPEN) {
      lobbyWebSocket.send(JSON.stringify({
        type: 'TOGGLE_READY',
        ready: !isLobbyReady
      }));
      setIsLobbyReady(!isLobbyReady);
    }
  };

  const handleLeaveMatch = async () => {
    if (!activeMatch) return;
    setLobbyError('');
    try {
      const res = await fetch(`${API_BASE}/matches/leave/${activeMatch.id}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        setActiveMatch(null);
        setIsLobbyReady(false);
      } else {
        const data = await res.json();
        setLobbyError(data.detail || 'Failed to leave match');
      }
    } catch {
      setLobbyError('Failed to communicate with match server.');
    }
  };

  const handleCopyId = (text) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => alert('Match ID copied to clipboard!'))
        .catch(() => fallbackCopyId(text));
    } else {
      fallbackCopyId(text);
    }
  };

  const fallbackCopyId = (text) => {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.top = "0";
    textArea.style.left = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      alert('Match ID copied to clipboard!');
    } catch (err) {
      alert('Failed to copy. Match ID: ' + text);
    }
    document.body.removeChild(textArea);
  };

  const handleLogout = () => {
    setToken('');
    setActiveMatch(null);
  };

  // Filter leaderboard
  const filteredLeaderboard = leaderboard.filter(item =>
    item.username.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Compute leaderboard stats
  const totalPlayers = leaderboard.length;
  const highestElo = totalPlayers > 0 ? Math.max(...leaderboard.map(u => u.elo_rating)) : 1200;
  const averageElo = totalPlayers > 0 ? Math.round(leaderboard.reduce((acc, u) => acc + u.elo_rating, 0) / totalPlayers) : 1200;

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      
      {/* --- Premium Navigation Header --- */}
      <header style={{
        background: 'rgba(15, 23, 42, 0.4)',
        backdropFilter: 'blur(10px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        padding: '16px 32px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        position: 'sticky',
        top: 0,
        zIndex: 100
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }} onClick={() => setActiveTab('leaderboard')}>
          <div style={{ background: 'linear-gradient(135deg, #6366f1, #d946ef)', padding: '8px', borderRadius: '10px' }}>
            <Gamepad2 color="white" size={24} />
          </div>
          <span style={{
            fontFamily: "'Outfit', sans-serif",
            fontWeight: 800,
            fontSize: '22px',
            letterSpacing: '1px',
            background: 'linear-gradient(90deg, #f8fafc, #cbd5e1)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent'
          }}>
            LEET<span style={{ color: '#6366f1' }}>RACE</span>
          </span>
        </div>

        <nav style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <button 
            onClick={() => setActiveTab('leaderboard')}
            style={{
              background: 'transparent',
              border: 'none',
              color: activeTab === 'leaderboard' ? '#6366f1' : '#94a3b8',
              fontSize: '15px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              borderRadius: '8px',
              backgroundColor: activeTab === 'leaderboard' ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
              transition: 'all 0.2s'
            }}
          >
            <Trophy size={16} /> Leaderboard
          </button>
          
          <button 
            onClick={() => {
              if (token) setActiveTab('lobby');
              else setActiveTab('auth');
            }}
            style={{
              background: 'transparent',
              border: 'none',
              color: activeTab === 'lobby' || activeTab === 'auth' ? '#6366f1' : '#94a3b8',
              fontSize: '15px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 16px',
              borderRadius: '8px',
              backgroundColor: activeTab === 'lobby' || activeTab === 'auth' ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
              transition: 'all 0.2s'
            }}
          >
            <Play size={16} /> Race Arena
          </button>

          {user ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginLeft: '12px', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <span style={{ fontSize: '14px', fontWeight: 700, color: '#f8fafc' }}>{user.username}</span>
                <span style={{ fontSize: '11px', color: '#60a5fa', fontWeight: 600 }}>ELO: {user.elo_rating}</span>
              </div>
              <button 
                onClick={handleLogout}
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  border: 'none',
                  color: '#f87171',
                  padding: '8px',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  transition: 'background 0.2s'
                }}
                title="Logout"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            activeTab !== 'auth' && (
              <button 
                onClick={() => setActiveTab('auth')}
                className="glow-btn"
                style={{ padding: '8px 20px', fontSize: '14px' }}
              >
                Sign In
              </button>
            )
          )}
        </nav>
      </header>

      {/* --- Main App Body --- */}
      <main style={{ flex: 1, padding: '40px 32px', maxWidth: '1280px', width: '100%', margin: '0 auto' }}>
        
        {/* ========================================================================= */}
        {/* --- LEADERBOARD VIEW ---                                                  */}
        {/* ========================================================================= */}
        {activeTab === 'leaderboard' && (
          <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '30px' }}>
            
            {/* Top Info Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: '20px' }}>
              <div>
                <h1 style={{ fontFamily: "'Outfit', sans-serif", fontSize: '36px', fontWeight: 800, letterSpacing: '-0.5px' }}>
                  Global Rankings
                </h1>
                <p style={{ color: '#94a3b8', fontSize: '15px', marginTop: '4px' }}>
                  Top competitive coders ranked by real-time ELO. Solve correct DSA sheet questions to climb.
                </p>
              </div>

              {/* Search filter bar */}
              <div style={{ position: 'relative', width: '300px' }}>
                <Search style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#64748b' }} size={16} />
                <input 
                  type="text"
                  placeholder="Search competitor..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 16px 10px 38px',
                    backgroundColor: 'rgba(30, 41, 59, 0.4)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '10px',
                    color: 'white',
                    outline: 'none',
                    fontSize: '14px',
                    fontFamily: 'inherit',
                    transition: 'border-color 0.2s'
                  }}
                  onFocus={(e) => e.target.style.borderColor = '#6366f1'}
                  onBlur={(e) => e.target.style.borderColor = 'rgba(255,255,255,0.08)'}
                />
              </div>
            </div>

            {/* Quick Stats Panel */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '20px' }}>
              <div className="glass-card" style={{ padding: '20px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ padding: '12px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '12px', color: '#6366f1' }}>
                  <Trophy size={28} />
                </div>
                <div>
                  <span style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Highest ELO Rating</span>
                  <h3 style={{ fontSize: '24px', fontWeight: 800, marginTop: '2px' }}>{highestElo}</h3>
                </div>
              </div>

              <div className="glass-card" style={{ padding: '20px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ padding: '12px', background: 'rgba(96, 165, 250, 0.1)', borderRadius: '12px', color: '#60a5fa' }}>
                  <TrendingUp size={28} />
                </div>
                <div>
                  <span style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Average Competitor ELO</span>
                  <h3 style={{ fontSize: '24px', fontWeight: 800, marginTop: '2px' }}>{averageElo}</h3>
                </div>
              </div>

              <div className="glass-card" style={{ padding: '20px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                <div style={{ padding: '12px', background: 'rgba(217, 70, 239, 0.1)', borderRadius: '12px', color: '#d946ef' }}>
                  <UserIcon size={28} />
                </div>
                <div>
                  <span style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 600 }}>Active Challengers</span>
                  <h3 style={{ fontSize: '24px', fontWeight: 800, marginTop: '2px' }}>{totalPlayers}</h3>
                </div>
              </div>
            </div>

            {/* Rankings Table */}
            <div className="glass-card" style={{ overflow: 'hidden', padding: 0 }}>
              {loadingLeaderboard ? (
                <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>Retrieving Leaderboard...</div>
              ) : filteredLeaderboard.length === 0 ? (
                <div style={{ padding: '40px', textAlign: 'center', color: '#94a3b8' }}>No competitors matched your query.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                      <th style={{ padding: '16px 24px', fontSize: '13px', color: '#94a3b8', fontWeight: 600 }}>RANK</th>
                      <th style={{ padding: '16px 24px', fontSize: '13px', color: '#94a3b8', fontWeight: 600 }}>COMPETITOR</th>
                      <th style={{ padding: '16px 24px', fontSize: '13px', color: '#94a3b8', fontWeight: 600, textAlign: 'center' }}>ELO RATING</th>
                      <th style={{ padding: '16px 24px', fontSize: '13px', color: '#94a3b8', fontWeight: 600, textAlign: 'center' }}>WINS</th>
                      <th style={{ padding: '16px 24px', fontSize: '13px', color: '#94a3b8', fontWeight: 600, textAlign: 'center' }}>MATCHES</th>
                      <th style={{ padding: '16px 24px', fontSize: '13px', color: '#94a3b8', fontWeight: 600, textAlign: 'center' }}>WIN RATE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLeaderboard.map((player, idx) => {
                      const winRate = player.total_matches > 0 
                        ? Math.round((player.total_wins / player.total_matches) * 100) 
                        : 0;
                      
                      // Highlight top ranks
                      let rankBadge = `${idx + 1}`;
                      let rowBg = 'transparent';
                      let nameColor = '#f8fafc';

                      if (idx === 0) {
                        rankBadge = '🥇';
                        rowBg = 'rgba(245, 158, 11, 0.03)';
                        nameColor = '#f59e0b';
                      } else if (idx === 1) {
                        rankBadge = '🥈';
                        rowBg = 'rgba(226, 232, 240, 0.02)';
                      } else if (idx === 2) {
                        rankBadge = '🥉';
                        rowBg = 'rgba(180, 83, 9, 0.02)';
                      }

                      return (
                        <tr 
                          key={player.id} 
                          style={{ 
                            background: rowBg, 
                            borderBottom: '1px solid rgba(255,255,255,0.04)',
                            transition: 'background 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'}
                          onMouseLeave={(e) => e.currentTarget.style.background = rowBg}
                        >
                          <td style={{ padding: '16px 24px', fontWeight: 700, fontSize: '15px' }}>{rankBadge}</td>
                          <td style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'linear-gradient(135deg, #1e293b, #334155)', display: 'flex', justifyContent: 'center', alignItems: 'center', fontWeight: 'bold', color: '#cbd5e1' }}>
                              {player.username[0].toUpperCase()}
                            </div>
                            <span style={{ fontWeight: 600, color: nameColor }}>{player.username}</span>
                            {player.id === user?.id && <span style={{ padding: '2px 6px', background: 'rgba(99, 102, 241, 0.2)', color: '#818cf8', borderRadius: '4px', fontSize: '10px', fontWeight: 700 }}>YOU</span>}
                          </td>
                          <td style={{ padding: '16px 24px', fontWeight: 700, textAlign: 'center', color: '#60a5fa' }}>{player.elo_rating}</td>
                          <td style={{ padding: '16px 24px', textAlign: 'center', color: '#10b981', fontWeight: 600 }}>{player.total_wins}</td>
                          <td style={{ padding: '16px 24px', textAlign: 'center', color: '#cbd5e1' }}>{player.total_matches}</td>
                          <td style={{ padding: '16px 24px', textAlign: 'center' }}>
                            <span style={{ 
                              padding: '4px 10px', 
                              backgroundColor: winRate >= 50 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', 
                              color: winRate >= 50 ? '#34d399' : '#f87171',
                              borderRadius: '6px',
                              fontSize: '13px',
                              fontWeight: 600
                            }}>
                              {winRate}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

          </div>
        )}

        {/* ========================================================================= */}
        {/* --- AUTH VIEW (Login / Register) ---                                      */}
        {/* ========================================================================= */}
        {activeTab === 'auth' && (
          <div className="animate-fade-in" style={{ display: 'flex', justifyContent: 'center', padding: '40px 0' }}>
            <div className="glass-card" style={{ width: '400px', padding: '32px' }}>
              <div style={{ textAlign: 'center', marginBottom: '28px' }}>
                <h2 style={{ fontSize: '28px', fontWeight: 800, fontFamily: "'Outfit', sans-serif" }}>
                  {isRegister ? 'Create Account' : 'Welcome Back'}
                </h2>
                <p style={{ color: '#94a3b8', fontSize: '14px', marginTop: '6px' }}>
                  {isRegister ? 'Join the LeetRace rankings and challenge coders.' : 'Enter your credentials to access the Arena.'}
                </p>
              </div>

              {authError && (
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '8px', 
                  backgroundColor: 'rgba(239, 68, 68, 0.15)', 
                  border: '1px solid rgba(239, 68, 68, 0.2)', 
                  padding: '12px', 
                  borderRadius: '8px', 
                  color: '#f87171',
                  fontSize: '13px',
                  marginBottom: '20px'
                }}>
                  <ShieldAlert size={16} />
                  <span>{authError}</span>
                </div>
              )}

              <form onSubmit={handleAuth} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1' }}>Username</label>
                  <input 
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    style={{
                      padding: '10px 14px',
                      backgroundColor: 'rgba(15, 23, 42, 0.6)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '8px',
                      color: 'white',
                      fontSize: '14px',
                      outline: 'none'
                    }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1' }}>Password</label>
                  <input 
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={{
                      padding: '10px 14px',
                      backgroundColor: 'rgba(15, 23, 42, 0.6)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '8px',
                      color: 'white',
                      fontSize: '14px',
                      outline: 'none'
                    }}
                  />
                </div>

                <button 
                  type="submit" 
                  className="glow-btn"
                  style={{ width: '100%', padding: '12px', marginTop: '8px', fontSize: '15px' }}
                >
                  {isRegister ? 'Sign Up' : 'Sign In'}
                </button>
              </form>

              <div style={{ marginTop: '20px', textAlign: 'center', fontSize: '13px', color: '#94a3b8' }}>
                {isRegister ? 'Already have an account?' : "New to LeetRace?"}{' '}
                <span 
                  onClick={() => {
                    setIsRegister(!isRegister);
                    setAuthError('');
                  }}
                  style={{ color: '#6366f1', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                >
                  {isRegister ? 'Sign In here' : 'Register here'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================================= */}
        {/* --- RACE ARENA / LOBBY VIEW ---                                           */}
        {/* ========================================================================= */}
        {activeTab === 'lobby' && (
          <div className="animate-fade-in">
            
            {/* LOBBY INTERACTIVE SCREEN */}
            {activeMatch ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0' }}>
                <div className="glass-card" style={{ width: '600px', padding: '32px', textAlign: 'center' }}>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                    <div style={{ padding: '16px', background: 'rgba(99, 102, 241, 0.1)', borderRadius: '50%', color: '#6366f1' }}>
                      <Gamepad2 size={36} />
                    </div>
                  </div>
                  
                  <h2 style={{ fontSize: '28px', fontWeight: 800, fontFamily: "'Outfit', sans-serif" }}>Match Lobby</h2>
                  <p style={{ color: '#60a5fa', fontWeight: 600, marginTop: '4px' }}>Topic: {activeMatch.striver_topic}</p>
                  <p style={{ color: '#94a3b8', fontSize: '13px', marginTop: '2px' }}>Waiting for both competitors to click Ready...</p>

                  {/* Competitors Display */}
                  <div style={{ display: 'flex', justifyContent: 'space-around', margin: '40px 0', alignItems: 'center' }}>
                    {/* Player 1 (Host) */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                      <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'linear-gradient(135deg, #6366f1, #3b82f6)', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '20px', fontWeight: 'bold' }}>
                        {activeMatch.host?.username[0].toUpperCase()}
                      </div>
                      <span style={{ fontWeight: 700, fontSize: '15px' }}>{activeMatch.host?.username}</span>
                      <span style={{ fontSize: '12px', color: '#94a3b8' }}>ELO: {activeMatch.host?.elo_rating}</span>
                      
                      <div style={{ 
                        marginTop: '10px',
                        padding: '6px 14px',
                        backgroundColor: activeMatch.players?.find(p => p.id === activeMatch.host_id)?.is_ready 
                          ? 'rgba(16, 185, 129, 0.15)' 
                          : 'rgba(239, 68, 68, 0.15)',
                        color: activeMatch.players?.find(p => p.id === activeMatch.host_id)?.is_ready ? '#34d399' : '#f87171',
                        borderRadius: '20px',
                        fontSize: '12px',
                        fontWeight: 700
                      }}>
                        {activeMatch.players?.find(p => p.id === activeMatch.host_id)?.is_ready ? 'Ready' : 'Not Ready'}
                      </div>
                    </div>

                    <span style={{ fontSize: '24px', fontWeight: 800, color: '#475569', fontStyle: 'italic' }}>VS</span>

                    {/* Player 2 (Guest) */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
                      {activeMatch.guest_id ? (
                        <>
                          <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'linear-gradient(135deg, #ec4899, #d946ef)', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '20px', fontWeight: 'bold' }}>
                            {activeMatch.guest?.username[0].toUpperCase()}
                          </div>
                          <span style={{ fontWeight: 700, fontSize: '15px' }}>{activeMatch.guest?.username}</span>
                          <span style={{ fontSize: '12px', color: '#94a3b8' }}>ELO: {activeMatch.guest?.elo_rating}</span>
                          
                          <div style={{ 
                            marginTop: '10px',
                            padding: '6px 14px',
                            backgroundColor: activeMatch.players?.find(p => p.id === activeMatch.guest_id)?.is_ready 
                              ? 'rgba(16, 185, 129, 0.15)' 
                              : 'rgba(239, 68, 68, 0.15)',
                            color: activeMatch.players?.find(p => p.id === activeMatch.guest_id)?.is_ready ? '#34d399' : '#f87171',
                            borderRadius: '20px',
                            fontSize: '12px',
                            fontWeight: 700
                          }}>
                            {activeMatch.players?.find(p => p.id === activeMatch.guest_id)?.is_ready ? 'Ready' : 'Not Ready'}
                          </div>
                        </>
                      ) : (
                        <>
                          <div style={{ width: '56px', height: '56px', borderRadius: '50%', border: '2px dashed #475569', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '20px', color: '#475569' }}>
                            ?
                          </div>
                          <span style={{ fontWeight: 600, fontSize: '14px', color: '#64748b' }}>Waiting for Opponent</span>
                          <span style={{ fontSize: '12px', color: '#475569' }}>Match ID: {activeMatch.id}</span>
                          <button 
                            onClick={() => handleCopyId(activeMatch.id)}
                            style={{ padding: '4px 10px', fontSize: '11px', background: '#334155', border: 'none', borderRadius: '4px', color: 'white', cursor: 'pointer', marginTop: '6px' }}
                          >
                            Copy ID
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {lobbyError && <p style={{ color: '#f87171', fontSize: '14px', marginBottom: '16px' }}>{lobbyError}</p>}

                  {activeMatch.guest_id && (
                    <button 
                      onClick={toggleReadyState}
                      className="glow-btn"
                      style={{ 
                        padding: '14px 40px', 
                        fontSize: '16px',
                        background: isLobbyReady ? 'rgba(16, 185, 129, 0.2)' : 'var(--primary-glow)',
                        border: isLobbyReady ? '1px solid #10b981' : 'none',
                        color: isLobbyReady ? '#34d399' : 'white',
                        width: '240px',
                        marginBottom: '10px'
                      }}
                    >
                      {isLobbyReady ? 'Waiting for opponent...' : 'I am Ready!'}
                    </button>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <button 
                      onClick={handleLeaveMatch}
                      style={{
                        padding: '10px 24px',
                        fontSize: '14px',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        borderRadius: '8px',
                        color: '#f87171',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                        width: '240px'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                    >
                      Leave Lobby
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              // GENERAL LOBBY LIST & CREATE
              <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: '30px' }}>
                
                {/* Match creation & Join section */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
                  <div className="glass-card" style={{ padding: '24px' }}>
                    <h2 style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Play size={20} color="#6366f1" /> Create a Race
                    </h2>
                    
                    {lobbyError && <div style={{ color: '#f87171', fontSize: '13px', marginBottom: '12px' }}>{lobbyError}</div>}

                    <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', flex: 1 }}>
                        <label style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1' }}>Select Striver's DSA Topic</label>
                        <select 
                          value={selectedTopic}
                          onChange={(e) => setSelectedTopic(e.target.value)}
                          style={{
                            padding: '10px 14px',
                            backgroundColor: 'rgba(15, 23, 42, 0.6)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            borderRadius: '8px',
                            color: 'white',
                            fontSize: '14px',
                            outline: 'none',
                            cursor: 'pointer'
                          }}
                        >
                          {topics.map(topic => (
                            <option key={topic} value={topic} style={{ backgroundColor: '#0f172a' }}>{topic}</option>
                          ))}
                        </select>
                      </div>

                      <button 
                        onClick={handleCreateMatch}
                        className="glow-btn"
                        style={{ padding: '11px 24px', fontSize: '14px' }}
                      >
                        Create Lobby
                      </button>
                    </div>
                  </div>

                  {/* Manual Join lobby via code */}
                  <div className="glass-card" style={{ padding: '24px' }}>
                    <h2 style={{ fontSize: '22px', fontWeight: 800, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Target size={20} color="#ec4899" /> Join via Code
                    </h2>
                    <div style={{ display: 'flex', gap: '16px' }}>
                      <input 
                        type="text"
                        placeholder="Enter Lobby ID (e.g. 5)"
                        id="lobby-id-input"
                        style={{
                          flex: 1,
                          padding: '10px 14px',
                          backgroundColor: 'rgba(15, 23, 42, 0.6)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          borderRadius: '8px',
                          color: 'white',
                          fontSize: '14px',
                          outline: 'none'
                        }}
                      />
                      <button 
                        onClick={() => {
                          const val = document.getElementById('lobby-id-input').value;
                          if (val) handleJoinMatch(parseInt(val));
                        }}
                        style={{
                          padding: '10px 24px',
                          background: 'linear-gradient(135deg, #ec4899, #d946ef)',
                          border: 'none',
                          borderRadius: '8px',
                          color: 'white',
                          fontWeight: 600,
                          fontSize: '14px',
                          cursor: 'pointer'
                        }}
                      >
                        Join Room
                      </button>
                    </div>
                  </div>
                </div>

                {/* Match History sidebar */}
                <div className="glass-card" style={{ padding: '24px' }}>
                  <h2 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Sparkles size={18} color="#f59e0b" /> Match History
                  </h2>
                  
                  {matchHistory.length === 0 ? (
                    <p style={{ color: '#64748b', fontSize: '13px', fontStyle: 'italic' }}>No matches recorded yet.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {matchHistory.map(m => {
                        const dateStr = new Date(m.created_at).toLocaleDateString();
                        const isHostWin = m.winner_id === m.host_id;
                        return (
                          <div key={m.id} style={{ padding: '12px', backgroundColor: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.04)', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 700, color: '#f8fafc' }}>
                                {m.host?.username} vs {m.guest?.username || '?'}
                              </div>
                              <span style={{ fontSize: '11px', color: '#64748b' }}>Topic: {m.striver_topic} • {dateStr}</span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <span style={{ 
                                padding: '2px 8px', 
                                backgroundColor: m.status === 'COMPLETED' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                                color: m.status === 'COMPLETED' ? '#34d399' : '#f87171',
                                borderRadius: '4px',
                                fontSize: '11px',
                                fontWeight: 700
                              }}>
                                {m.status}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>
            )}

          </div>
        )}

      </main>

      {/* --- Footer --- */}
      <footer style={{
        textAlign: 'center',
        padding: '24px',
        color: '#64748b',
        fontSize: '13px',
        borderTop: '1px solid rgba(255,255,255,0.04)',
        marginTop: 'auto'
      }}>
        LeetRace Platform © 2026 • Powering DSA Races
      </footer>

    </div>
  );
}

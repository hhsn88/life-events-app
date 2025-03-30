import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css'; // Import the CSS file
import logo from './logo.svg'; // Import the SVG logo from src

// --- Configuration ---
// Read Client ID and API Key from environment variables
const CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const API_KEY = process.env.REACT_APP_GOOGLE_API_KEY;
// SPREADSHEET_ID is now managed via state and localStorage

console.log('Loaded Client ID:', CLIENT_ID ? 'Exists' : 'MISSING');
console.log('Loaded API Key:', API_KEY ? 'Exists' : 'MISSING');

const SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";
const LOCAL_STORAGE_KEY = 'sheetsEventAppSpreadsheetId'; // Key for localStorage

// --- Helper Functions ---
function formatTimestamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

// --- Main App Component ---
function App() {
  // --- State Variables ---
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true); // Main loading state for initial load/auth
  const [isFetchingTopics, setIsFetchingTopics] = useState(false); // Specific loading for topics refresh
  const [isFetchingEvents, setIsFetchingEvents] = useState(false); // Specific loading for events
  const [isFetchingHeaders, setIsFetchingHeaders] = useState(false); // Specific loading for headers
  const [isGapiReady, setIsGapiReady] = useState(false);
  const [isGisReady, setIsGisReady] = useState(false);
  const [error, setError] = useState(null);
  const [topics, setTopics] = useState([]); // Stores { title, sheetId }
  const [selectedTopic, setSelectedTopic] = useState(''); // Stores title string
  const [events, setEvents] = useState([]);
  const [currentTopicHeaders, setCurrentTopicHeaders] = useState([]);
  const [showAddTopic, setShowAddTopic] = useState(false);
  const [newTopicName, setNewTopicName] = useState('');
  const [newTopicColumns, setNewTopicColumns] = useState('Event Description');
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [newEventCustomTime, setNewEventCustomTime] = useState('');
  const [newEventData, setNewEventData] = useState({}); // Stores { headerName: value }

  // State for configurable Spreadsheet ID
  const [userSpreadsheetId, setUserSpreadsheetId] = useState(''); // Holds the active ID
  const [spreadsheetIdInput, setSpreadsheetIdInput] = useState(''); // Temp state for the input field
  const [showIdInput, setShowIdInput] = useState(false); // Control visibility of input UI

  const tokenClient = useRef(null);
  const isSilentSigninAttempt = useRef(false);

  // *** Add an initial check for essential config ***
  useEffect(() => {
    // Check only once on mount
    if (!CLIENT_ID || !API_KEY) {
      setError("Configuration Error: Ensure REACT_APP_GOOGLE_CLIENT_ID and REACT_APP_GOOGLE_API_KEY are set in your .env file and the server was restarted.");
      setIsLoading(false);
      setIsGapiReady(false); setIsGisReady(false);
    }
  }, []);


  // --- Sign Out Handler ---
  const handleSignOutClick = useCallback(() => {
    console.log("handleSignOutClick called");
    const token = window.gapi?.client?.getToken();
    if (token !== null) {
      void window.google?.accounts?.oauth2?.revoke(token.access_token, () => {
        console.log('Access token revoked');
        void window.gapi?.client?.setToken(null);
        setIsSignedIn(false); setCurrentUser(null); setTopics([]);
        setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]);
        setNewEventData({}); setError(null); setIsLoading(false);
      });
    } else {
        console.log("handleSignOutClick: No token found, resetting state.");
        setIsSignedIn(false); setCurrentUser(null); setTopics([]);
        setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]);
        setNewEventData({}); setError(null); setIsLoading(false);
    }
  }, []);


  // --- API Callbacks (Memoized) ---
  const fetchUserProfile = useCallback(async () => {
      console.log("Attempting to fetch user profile...");
      if (!window.gapi?.client) { console.warn("GAPI client not ready"); return Promise.reject("GAPI client not ready"); }
      if (!window.gapi?.client?.people) {
          try { await window.gapi?.client?.load('https://people.googleapis.com/$discovery/rest?version=v1'); }
          catch (loadErr) { console.error("Error loading People API:", loadErr); setError(`Could not load People API: ${loadErr.message}`); return Promise.reject(loadErr); }
      }
      if (!window.gapi?.client?.people) { console.error("People API client library not available"); setError("People API client library not available."); return Promise.reject("People API not available"); }

      try {
          const response = await window.gapi.client.people.people.get({ resourceName: 'people/me', personFields: 'names,emailAddresses' });
          const profile = response.result;
          const primaryName = profile.names?.find(n => n.metadata?.primary)?.displayName ?? (profile.names?.length > 0 ? profile.names[0].displayName : 'User');
          const primaryEmail = profile.emailAddresses?.find(e => e.metadata?.primary)?.value ?? (profile.emailAddresses?.length > 0 ? profile.emailAddresses[0].value : 'No email');
          setCurrentUser({ name: primaryName, email: primaryEmail });
          console.log("fetchUserProfile finished successfully.");
          return Promise.resolve();
      } catch (err) {
          console.error("Error fetching user profile:", err); const errorMsg = `Could not fetch profile: ${err.result?.error?.message || err.message}`; setError(errorMsg);
          if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching profile, signing out.", err.status); setError(`Auth error fetching profile (${err.status}).`); handleSignOutClick(); }
          else { console.warn("Non-auth error fetching profile.", err.status); }
          console.log("fetchUserProfile finished with error.");
          return Promise.reject(err);
      }
  }, [handleSignOutClick]);

  const fetchTopics = useCallback(async (isInitialLoad = false, signedInStatus) => {
    console.log(`Attempting to fetch topics... (Signed-in status passed: ${signedInStatus})`);
    if (!userSpreadsheetId) { console.warn("Fetch topics skipped: Spreadsheet ID not set."); return Promise.resolve(); }
    if (!signedInStatus || !window.gapi?.client?.sheets) { console.log(`Fetch topics skipped.`); return Promise.resolve(); }

    console.log("Fetching topics list...");
    if (!isInitialLoad) setIsFetchingTopics(true); setError(null);
    try {
      const response = await window.gapi.client.sheets.spreadsheets.get({ spreadsheetId: userSpreadsheetId, fields: 'sheets(properties(title,sheetId))' });
      const sheets = response.result.sheets || [];
      const topicData = sheets.map(sheet => ({ title: sheet.properties.title, sheetId: sheet.properties.sheetId }));
      setTopics(topicData); console.log("Topics fetched and state updated:", topicData);
      const currentSelectedTopicExists = topicData.some(t => t.title === selectedTopic);
      if ((!currentSelectedTopicExists || !selectedTopic) && topicData.length > 0) { setSelectedTopic(topicData[0].title); }
      else if (topicData.length === 0) { setSelectedTopic(''); }
      console.log("fetchTopics finished successfully."); return Promise.resolve();
    } catch (err) {
      console.error("Error fetching topics:", err); const errorMsg = `Error fetching topics: ${err.result?.error?.message || err.message}.`; setError(errorMsg);
       if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching topics, signing out.", err.status); setError("Auth error fetching topics."); handleSignOutClick(); }
       else if (err.status === 404) { console.warn("Spreadsheet not found.", err.status); setError(`Spreadsheet not found or permission denied. Check ID.`); }
       else { console.warn("Non-auth/404 error fetching topics.", err.status); }
       console.log("fetchTopics finished with error."); return Promise.reject(err);
    } finally { if (!isInitialLoad) setIsFetchingTopics(false); }
  }, [handleSignOutClick, selectedTopic, userSpreadsheetId]);

  // --- Google API Initialization Callbacks (Memoized) ---
  const initializeGapiClient = useCallback(async () => {
    if (!API_KEY) { console.error("API Key missing"); return; }
    console.log("Initializing GAPI client...");
    try {
      await window.gapi.client.init({ apiKey: API_KEY });
      await window.gapi.client.load('https://sheets.googleapis.com/$discovery/rest?version=v4');
      setIsGapiReady(true);
      console.log("GAPI client initialized successfully and Sheets API loaded.");
    } catch (err) {
      console.error("Error initializing GAPI client or loading Sheets API:", err);
      setError(`Error initializing Google API Client: ${err.message || JSON.stringify(err)}`);
      setIsGapiReady(false); setIsLoading(false);
    }
  }, []);

  const initializeGisClient = useCallback(() => {
    if (!CLIENT_ID) { console.error("Client ID missing"); return; }
    console.log("Initializing GIS client...");
    try {
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID, scope: SCOPES,
            callback: (tokenResponse) => {
                console.log("GIS Token Callback received:", tokenResponse);
                const wasSilentAttempt = isSilentSigninAttempt.current;
                isSilentSigninAttempt.current = false;
                if (tokenResponse.error) {
                    console.error(`GIS Token Callback Error: ${tokenResponse.error}, Subtype: ${tokenResponse.error_subtype}, Desc: ${tokenResponse.error_description}`);
                    const silentInteractionRequired = wasSilentAttempt && (tokenResponse.error === 'interaction_required' || tokenResponse.error === 'access_denied');
                    if (!silentInteractionRequired) { setError(`Google Sign-In Error: ${tokenResponse.error || 'Unknown error'}`); }
                    else { console.log("Silent sign-in requires user interaction."); }
                    setIsSignedIn(false); setIsLoading(false); return;
                }
                if (tokenResponse && tokenResponse.access_token) {
                    console.log("GIS Token obtained successfully.");
                    window.gapi.client.setToken({ access_token: tokenResponse.access_token });
                    setIsSignedIn(true); console.log("Set isSignedIn = true.");
                } else {
                    console.error("GIS Token response missing access token:", tokenResponse);
                    setError("Failed to obtain access token from Google (unexpected response).");
                    setIsSignedIn(false); setIsLoading(false);
                }
            },
            error_callback: (error) => {
                console.warn("GIS Token Client error_callback triggered:", error);
                const wasSilentAttempt = isSilentSigninAttempt.current;
                isSilentSigninAttempt.current = false;
                const silentFailureTypes = ['popup_closed', 'immediate_failed', 'user_cancel', 'opt_out_or_no_session', 'suppressed_by_user'];
                const isKnownSilentFailure = error.type && silentFailureTypes.includes(error.type);
                const treatAsSilent = wasSilentAttempt && (isKnownSilentFailure || error.type === 'popup_failed_to_open');
                if (treatAsSilent) { console.log(`Silent sign-in failed via error_callback (Reason: ${error.type}).`); }
                else { setError(`Google Sign-In Error: ${error.type || 'Unknown error'}`); }
                setIsSignedIn(false); setIsLoading(false);
            }
        });
        setIsGisReady(true);
        console.log("GIS Token Client initialized successfully.");
    } catch (err) {
        console.error("Error initializing GIS Token Client:", err);
        setError(`Error initializing Google Sign-In: ${err.message || JSON.stringify(err)}`);
        setIsGisReady(false); setIsLoading(false);
    }
  }, []);

  const loadGapiScript = useCallback(() => {
    if (error?.startsWith("Configuration Error")) return null;
    console.log("Loading GAPI script...");
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true; script.defer = true;
    script.onload = () => { console.log("GAPI script loaded."); if (window.gapi) { window.gapi.load('client', initializeGapiClient); } else { setError("GAPI script loaded but window.gapi not available."); } };
    script.onerror = () => setError("Failed to load Google API script.");
    document.body.appendChild(script); return script;
  }, [initializeGapiClient, error]);

  const loadGisScript = useCallback(() => {
    if (error?.startsWith("Configuration Error")) return null;
    console.log("Loading GIS script...");
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true; script.defer = true;
    script.onload = () => { console.log("GIS script loaded."); if (window.google?.accounts?.oauth2) { initializeGisClient(); } else { setError("GIS script loaded but google.accounts.oauth2 not available."); } };
    script.onerror = () => setError("Failed to load Google Identity Services script.");
    document.body.appendChild(script); return script;
  }, [initializeGisClient, error]);

  const fetchEvents = useCallback(async () => {
    if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
    console.log(`Attempting to fetch events for topic: ${selectedTopic}`);
    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) { console.log("Fetch events skipped."); setEvents([]); return; }
    console.log(`Fetching events for topic: ${selectedTopic}`);
    setIsFetchingEvents(true); setError(null);
    try {
      const range = `${selectedTopic}!A2:B`;
      const response = await window.gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: userSpreadsheetId, range: range });
      const values = response.result.values || [];
      const loadedEvents = values.map((row, index) => ({ id: `${selectedTopic}-${index}`, timestamp: row[0] || '', description: row[1] || '', rowNum: index + 2 })).sort((a, b) => { const dateA = new Date(a.timestamp); const dateB = new Date(b.timestamp); if (isNaN(dateA)) return 1; if (isNaN(dateB)) return -1; return dateB - dateA; });
      setEvents(loadedEvents);
    } catch (err) {
      console.error("Error fetching events:", err);
       const errorMessage = err.result?.error?.message || '';
       if (err.status === 400 && (errorMessage.includes('Unable to parse range') || errorMessage.includes('exceeds grid limits'))) { console.log(`Sheet "${selectedTopic}" is likely empty/new.`); setEvents([]); }
       else { const errorMsg = `Error fetching events: ${errorMessage}`; setError(errorMsg); if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching events.", err.status); setError("Auth error fetching events."); handleSignOutClick(); } else { console.warn("Non-auth/grid error fetching events.", err.status); } }
    } finally { console.log("fetchEvents finished."); setIsFetchingEvents(false); }
  }, [selectedTopic, isSignedIn, handleSignOutClick, userSpreadsheetId]);

  const fetchTopicHeaders = useCallback(async (topicTitle) => {
      if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
      console.log(`Attempting to fetch headers for topic: ${topicTitle}`);
      if (!topicTitle || !isSignedIn || !window.gapi?.client?.sheets) { console.log("Fetch headers skipped."); setCurrentTopicHeaders([]); return; }
      console.log(`Fetching headers for topic: ${topicTitle}`);
      setIsFetchingHeaders(true); setError(null);
      try {
          const range = `${topicTitle}!1:1`;
          const response = await window.gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: userSpreadsheetId, range: range });
          const headers = response.result.values?.[0] || [];
          setCurrentTopicHeaders(headers);
      } catch (err) {
          console.error("Error fetching topic headers:", err); const errorMsg = `Error fetching headers: ${err.result?.error?.message || err.message}`; setError(errorMsg);
          setCurrentTopicHeaders([]);
          if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching headers.", err.status); setError("Auth error fetching headers."); handleSignOutClick(); }
          else { console.warn("Non-auth error fetching headers.", err.status); }
      } finally { console.log("fetchTopicHeaders finished."); setIsFetchingHeaders(false); }
  }, [isSignedIn, handleSignOutClick, userSpreadsheetId]);


  // --- Action Handlers (Memoized) ---
  const handleAuthClick = useCallback(() => {
    if (error?.startsWith("Configuration Error")) return;
    console.log("handleAuthClick called");
    setError(null);
    if (!tokenClient.current) { setError("Google Sign-In is not ready yet."); setIsLoading(false); return; }
    console.log("Requesting token access via GIS (with consent prompt)..."); setIsLoading(true);
    isSilentSigninAttempt.current = false; // Explicit attempt
    tokenClient.current.requestAccessToken({ prompt: 'consent' });
  }, [error]);

  const handleAddTopic = useCallback(async (e) => {
    e.preventDefault(); if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
    console.log("handleAddTopic called");
    const trimmedTopicName = newTopicName.trim(); const trimmedColumns = newTopicColumns.trim();
    if (!trimmedTopicName || !isSignedIn || !window.gapi?.client?.sheets) { setError("Topic name cannot be empty, or not signed in/ready."); return; }
    if (topics.some(topic => topic.title === trimmedTopicName)) { setError(`Topic "${trimmedTopicName}" already exists.`); return; }
    const userColumns = trimmedColumns ? trimmedColumns.split(',').map(col => col.trim()).filter(Boolean) : ['Event Description'];
    const finalHeaders = ["Timestamp", ...userColumns]; const columnCount = finalHeaders.length;
    console.log(`Adding topic: ${trimmedTopicName} with columns: ${finalHeaders.join(', ')}`);
    setIsLoading(true); setError(null);
    try {
      const addSheetRequest = { requests: [ { addSheet: { properties: { title: trimmedTopicName, gridProperties: { rowCount: 1, columnCount: columnCount } } } } ] };
      const response = await window.gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: userSpreadsheetId, resource: addSheetRequest });
      const newSheetProperties = response.result.replies?.[0]?.addSheet?.properties; const newSheetId = newSheetProperties?.sheetId;
      if (!newSheetId && newSheetId !== 0) { throw new Error("Could not get sheetId for new sheet."); }
      await window.gapi.client.sheets.spreadsheets.values.update({ spreadsheetId: userSpreadsheetId, range: `${trimmedTopicName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [finalHeaders] } });
      setNewTopicName(''); setNewTopicColumns('Event Description'); setShowAddTopic(false);
      const newTopic = { title: trimmedTopicName, sheetId: newSheetId };
      setTopics(prevTopics => [...prevTopics, newTopic]);
      setSelectedTopic(trimmedTopicName);
    } catch (err) {
      console.error("Error adding topic:", err); const errorMsg = `Error adding topic: ${err.result?.error?.message || err.message}`; setError(errorMsg);
      if (err.status === 401 || err.status === 403) { console.warn("Auth error adding topic.", err.status); setError("Auth error adding topic."); handleSignOutClick(); }
      else { console.warn("Non-auth error adding topic.", err.status); }
    } finally { console.log("handleAddTopic finished."); setIsLoading(false); }
  }, [newTopicName, newTopicColumns, isSignedIn, topics, handleSignOutClick, userSpreadsheetId]);

  const handleAddEvent = useCallback(async (e) => {
    e.preventDefault(); if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
    console.log("handleAddEvent called");
    if (currentTopicHeaders.length === 0) { setError("Topic headers not loaded."); return; }
    const hasDynamicData = Object.values(newEventData).some(val => val && val.trim() !== '');
    const isTimestampOnly = currentTopicHeaders.length === 1;
    if (!isTimestampOnly && !hasDynamicData) { setError(`Please fill in at least one event detail.`); return; }
    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) { setError("Cannot add event: Not ready."); return; }
    console.log(`Adding event to topic: ${selectedTopic}`);
    setIsLoading(true); setError(null);
    try {
      let timestamp = formatTimestamp(); const trimmedTime = newEventCustomTime.trim();
      if (trimmedTime) {
          if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmedTime)) { const parsedDate = new Date(trimmedTime); if (!isNaN(parsedDate.getTime())) { timestamp = formatTimestamp(parsedDate); } else { setError("Invalid custom date format."); setIsLoading(false); return; } }
          else { setError("Invalid custom date format."); setIsLoading(false); return; }
      }
      const rowData = currentTopicHeaders.map((header, index) => (index === 0 ? timestamp : (newEventData[header] || '')));
      const values = [rowData]; const body = { values: values };
      await window.gapi.client.sheets.spreadsheets.values.append({ spreadsheetId: userSpreadsheetId, range: selectedTopic, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', resource: body });
      setNewEventCustomTime(''); setNewEventData({}); setShowAddEvent(false);
      await fetchEvents();
    } catch (err) {
      console.error("Error adding event:", err); const errorMsg = `Error adding event: ${err.result?.error?.message || err.message}`; setError(errorMsg);
      if (err.status === 401 || err.status === 403) { console.warn("Auth error adding event.", err.status); setError("Auth error adding event."); handleSignOutClick(); }
      else { console.warn("Non-auth error adding event.", err.status); }
    } finally { console.log("handleAddEvent finished."); setIsLoading(false); }
  }, [selectedTopic, isSignedIn, newEventCustomTime, fetchEvents, handleSignOutClick, currentTopicHeaders, newEventData, userSpreadsheetId]);

  const handleDeleteEvent = useCallback(async (eventToDelete, sheetId) => {
      if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
      if (!eventToDelete || sheetId === undefined || !isSignedIn || !window.gapi?.client?.sheets) { setError("Cannot delete event: missing data/state."); return; }
      if (!window.confirm(`Delete event: "${eventToDelete.description}"?`)) { return; }
      console.log(`Deleting row: ${eventToDelete.rowNum} from sheetId: ${sheetId}`);
      setIsLoading(true); setError(null);
      try {
          const deleteRequest = { requests: [ { deleteDimension: { range: { sheetId: sheetId, dimension: "ROWS", startIndex: eventToDelete.rowNum - 1, endIndex: eventToDelete.rowNum } } } ] };
          await window.gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: userSpreadsheetId, resource: deleteRequest });
          setEvents(prevEvents => prevEvents.filter(event => event.id !== eventToDelete.id));
      } catch (err) {
          console.error("Error deleting event:", err); const errorMsg = `Error deleting event: ${err.result?.error?.message || err.message}`; setError(errorMsg);
          if (err.status === 401 || err.status === 403) { console.warn("Auth error deleting event.", err.status); setError("Auth error deleting event."); handleSignOutClick(); }
          else { console.warn("Non-auth error deleting event.", err.status); }
      } finally { console.log("handleDeleteEvent finished."); setIsLoading(false); }
  }, [isSignedIn, handleSignOutClick, userSpreadsheetId]);

  const handleNewEventDataChange = (header, value) => setNewEventData(prevData => ({ ...prevData, [header]: value }));

  const handleSaveSpreadsheetId = () => {
      const trimmedId = spreadsheetIdInput.trim();
      if (trimmedId) {
          console.log("Saving Spreadsheet ID:", trimmedId);
          localStorage.setItem(LOCAL_STORAGE_KEY, trimmedId);
          setUserSpreadsheetId(trimmedId);
          setError(null); setShowIdInput(false);
          if (isSignedIn) {
              setTopics([]); setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]);
              fetchTopics(true, true); // Fetch topics for the new sheet ID
          }
      } else { setError("Please enter a valid Spreadsheet ID."); }
  };

  const handleChangeSpreadsheetId = () => {
      setShowIdInput(true); setTopics([]); setSelectedTopic('');
      setEvents([]); setCurrentTopicHeaders([]); setError(null);
  };

  // --- Helper to get sheetId (defined after topics state) ---
  const getCurrentSheetId = () => topics.find(t => t.title === selectedTopic)?.sheetId;

  // --- Effects (defined after all needed functions are defined) ---

  useEffect(() => { // Config Check Effect
    if (!CLIENT_ID || !API_KEY) {
      setError("Configuration Error: Ensure REACT_APP_GOOGLE_CLIENT_ID and REACT_APP_GOOGLE_API_KEY are set in your .env file and the server was restarted.");
      setIsLoading(false); setIsGapiReady(false); setIsGisReady(false);
    }
  }, []);

  useEffect(() => { // Load saved Spreadsheet ID
      const savedId = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (savedId) {
          console.log("Loaded Spreadsheet ID from localStorage:", savedId);
          setUserSpreadsheetId(savedId); setSpreadsheetIdInput(savedId); setShowIdInput(false);
      } else {
          console.log("No Spreadsheet ID found in localStorage.");
          setShowIdInput(true); setIsLoading(false);
      }
  }, []);

  useEffect(() => { // Script Loading Effect
    if (error?.startsWith("Configuration Error")) return;
    console.log("Mount effect: Loading scripts.");
    const gapiScript = loadGapiScript();
    const gisScript = loadGisScript();
    return () => {
      console.log("Cleanup effect: Removing scripts.");
      if (gapiScript?.parentNode) document.body.removeChild(gapiScript);
      if (gisScript?.parentNode) document.body.removeChild(gisScript);
    };
  }, [loadGapiScript, loadGisScript, error]); // load functions are memoized

  useEffect(() => { // Silent Sign-in Attempt Effect
    if (error?.startsWith("Configuration Error") || !isGapiReady || !isGisReady) return;
    console.log(`Readiness effect: isGapiReady=${isGapiReady}, isGisReady=${isGisReady}`);
    if (!isSignedIn) {
        console.log("Attempting silent sign-in after short delay...");
        const timerId = setTimeout(() => {
            if (tokenClient.current) {
              console.log("Setting silent sign-in flag and calling requestAccessToken with prompt: 'none'");
              isSilentSigninAttempt.current = true;
              setIsLoading(true);
              tokenClient.current.requestAccessToken({ prompt: 'none' });
            } else { console.error("Token client not ready for silent sign-in attempt."); setIsLoading(false); }
        }, 100);
        return () => clearTimeout(timerId);
    } else { setIsLoading(false); }
  }, [isGapiReady, isGisReady, error, isSignedIn]); // Dependencies

  useEffect(() => { // Fetch initial data Effect
      if (isSignedIn && isGapiReady && userSpreadsheetId) {
          console.log("isSignedIn, GAPI ready, and Spreadsheet ID available. Fetching initial data...");
          setIsLoading(true);
          Promise.allSettled([fetchUserProfile(), fetchTopics(true, true)]) // Pass true for initial load, true for signedInStatus
              .then((results) => {
                  console.log("Initial fetchUserProfile/fetchTopics settled:", results);
                  results.forEach((result, index) => {
                      if (result.status === 'rejected') { console.error(`Initial fetch ${index === 0 ? 'profile' : 'topics'} failed:`, result.reason); }
                  });
              })
              .finally(() => {
                  console.log("Setting main isLoading to false after initial fetches triggered by isSignedIn.");
                  setIsLoading(false);
              });
      } else if (!isSignedIn || !userSpreadsheetId) {
          if (!error?.startsWith("Configuration Error")) { setIsLoading(false); }
      }
  }, [isSignedIn, isGapiReady, userSpreadsheetId, fetchUserProfile, fetchTopics, error]); // Dependencies

  useEffect(() => { // Fetch Events/Headers on Topic Change Effect
    console.log(`Selected topic effect: selectedTopic=${selectedTopic}, isSignedIn=${isSignedIn}`);
    if (selectedTopic && isSignedIn && userSpreadsheetId) {
        fetchEvents(); fetchTopicHeaders(selectedTopic); setNewEventData({});
    } else {
        console.log("Clearing events list and headers.");
        setEvents([]); setCurrentTopicHeaders([]); setNewEventData({});
    }
  }, [selectedTopic, isSignedIn, userSpreadsheetId, fetchEvents, fetchTopicHeaders]); // Dependencies


  // --- UI Rendering ---
  const showAppLoading = isLoading && !error;

  if (error?.startsWith("Configuration Error")) {
     return ( <div className="app-container"> <div className="content-wrapper"> <div className="error-box">{error}</div> </div> </div> );
  }

  return (
    <div className="app-container">
      <div className="content-wrapper">
        {/* Header */}
        <header className="header">
            {/* Updated Title with Icon */}
            <h1>
                {/* Use img tag for SVG */}
                <img src={logo} alt="App logo" className="header-logo" />
                Life Events Tracker
            </h1>
            <div className="auth-controls">
                {showAppLoading && <div className="loader">Loading...</div>}
                {isGapiReady && isGisReady && !isSignedIn && !showAppLoading && ( <button onClick={handleAuthClick} disabled={showAppLoading} className="button button-primary"> Sign In with Google </button> )}
                {isSignedIn && currentUser && (
                    <div className="user-info">
                        {/* Display only email, lowercase */}
                        <span className="user-details">{currentUser.email.toLowerCase()}</span>
                        <button onClick={handleSignOutClick} className="button button-danger">Sign Out</button>
                    </div>
                )}
            </div>
        </header>
        {/* Error Display */}
        {error && !error.startsWith("Configuration Error") && ( <div className="error-box"> <strong>Error: </strong> <span>{error}</span> <button onClick={() => setError(null)} className="close-button">&times;</button> </div> )}
        {/* Spreadsheet ID Input Section */}
        {isSignedIn && (
            <section className="section spreadsheet-id-section">
                {!showIdInput && userSpreadsheetId ? (
                    <div className="spreadsheet-id-display">
                        {/* Updated Label */}
                        <span>Using Spreadsheet (ID): <code>{userSpreadsheetId}</code></span>
                        {/* Updated Button Class */}
                        <button onClick={handleChangeSpreadsheetId} className="button button-change-id button-small">Change</button>
                    </div>
                ) : (
                    <div className="form spreadsheet-id-form">
                        <label htmlFor="spreadsheet-id-input">Enter Google Spreadsheet ID:</label>
                        <div className="form-row">
                            <input id="spreadsheet-id-input" type="text" value={spreadsheetIdInput} onChange={(e) => setSpreadsheetIdInput(e.target.value)} placeholder="Paste Spreadsheet ID here" className="input-field" disabled={isLoading} />
                            <button onClick={handleSaveSpreadsheetId} disabled={isLoading} className="button button-primary">Save ID</button>
                            {userSpreadsheetId && <button type="button" onClick={() => { setShowIdInput(false); setSpreadsheetIdInput(userSpreadsheetId); setError(null); }} className="button button-secondary">Cancel</button>}
                        </div>
                        <p className="help-text">Find the ID in your spreadsheet's URL: .../spreadsheets/d/<b>SPREADSHEET_ID</b>/edit</p>
                    </div>
                )}
            </section>
        )}
        {/* Initializing Message */}
        {(!isGapiReady || !isGisReady) && !error && !showAppLoading && ( <p className="status-message">Initializing Google Services...</p> )}

        {/* Main Content Area */}
        {isSignedIn && userSpreadsheetId && !showAppLoading && (
          <main>
            {/* Topic Section */}
            <section className="section">
              <div className="section-header"> <h2>Topics</h2>
                <div className="controls">
                    {/* Updated Refresh Icon */}
                    <button onClick={() => fetchTopics(false, isSignedIn)} disabled={isFetchingTopics || isLoading} title="Refresh Topics" className="button button-icon"> <span role="img" aria-label="Refresh Topics">↻</span> </button>
                    <button onClick={() => setShowAddTopic(!showAddTopic)} className="button button-secondary" disabled={isLoading}> + Add Topic </button>
                </div>
              </div>
              {showAddTopic && ( <form onSubmit={handleAddTopic} className="form add-topic-form"> <div className="form-group"> <label htmlFor="new-topic">New Topic Name:</label> <input id="new-topic" type="text" value={newTopicName} onChange={(e) => setNewTopicName(e.target.value)} placeholder="e.g., Work Meetings" required className="input-field"/> </div> <div className="form-group"> <label htmlFor="new-topic-columns">Column Headers (after Timestamp, comma-separated):</label> <input id="new-topic-columns" type="text" value={newTopicColumns} onChange={(e) => setNewTopicColumns(e.target.value)} placeholder="e.g., Description, Category, Duration" className="input-field"/> <p className="help-text">Defaults to "Event Description". Timestamp column is always added first.</p> </div> <div className="form-actions"> <button type="submit" disabled={isLoading} className="button button-primary">Create</button> <button type="button" onClick={() => setShowAddTopic(false)} className="button button-secondary">Cancel</button> </div> </form> )}
              {isFetchingTopics && <p className="status-message">Loading topics...</p>}
              {!isFetchingTopics && topics.length > 0 ? ( <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)} disabled={isLoading} className="select-field"> <option value="" disabled={selectedTopic !== ''}>-- Select a Topic --</option> {topics.map(topic => ( <option key={topic.sheetId} value={topic.title}>{topic.title}</option> ))} </select> ) : ( !isFetchingTopics && isSignedIn && <p className="status-message">No topics found. Add one to get started!</p> )}
            </section>

            {/* Events Section */}
            {selectedTopic && (
              <section className="section">
                <div className="section-header"> <h2>Events for "{selectedTopic}"</h2> <button onClick={() => setShowAddEvent(!showAddEvent)} className="button button-secondary" disabled={isLoading || isFetchingHeaders}> + Add Event </button> </div>
                {showAddEvent && ( <form onSubmit={handleAddEvent} className="form add-event-form"> <div className="form-group"> <label htmlFor="new-event-time">Custom Timestamp (Optional):</label> <input id="new-event-time" type="text" value={newEventCustomTime} onChange={(e) => setNewEventCustomTime(e.target.value)} placeholder={`Format: YYYY-MM-DD HH:MM:SS (e.g., ${formatTimestamp()})`} className="input-field"/> <p className="help-text">Leave blank to use the current time.</p> </div> {currentTopicHeaders.slice(1).map((header, index) => ( <div className="form-group" key={`event-col-${index}`}> <label htmlFor={`event-input-${header}`}>{header}:</label> <input id={`event-input-${header}`} type="text" value={newEventData[header] || ''} onChange={(e) => handleNewEventDataChange(header, e.target.value)} className="input-field" /> </div> ))} <div className="form-actions"> <button type="submit" disabled={isLoading} className="button button-primary">Add Event</button> <button type="button" onClick={() => { setShowAddEvent(false); setNewEventData({}); setNewEventCustomTime(''); }} className="button button-secondary">Cancel</button> </div> </form> )}
                {isFetchingEvents && <p className="status-message">Loading events...</p>}
                {!isFetchingEvents && events.length > 0 ? ( <ul className="event-list"> {events.map(event => ( <li key={event.id} className="event-item"> <div className="event-content"> <p className="event-description">{event.description}</p> <p className="event-timestamp">{event.timestamp}</p> </div> <button onClick={() => handleDeleteEvent(event, getCurrentSheetId())} disabled={isLoading} className="button button-delete" title="Delete Event" aria-label={`Delete event: ${event.description}`}> &times; </button> </li> ))} </ul> ) : ( !isFetchingEvents && isSignedIn && selectedTopic && <p className="status-message">No events found for this topic yet.</p> )}
              </section>
            )}
          </main>
        )}
        {/* Prompts based on state */}
        {isSignedIn && !userSpreadsheetId && !showIdInput && !isLoading && ( <p className="status-message">Please configure a Spreadsheet ID to load data.</p> )}
        {!isSignedIn && isGapiReady && isGisReady && !showAppLoading && ( <p className="status-message">Please sign in to manage your event logs.</p> )}
      </div>
      <footer className="footer"> Ensure Client ID and API Key are set in .env and server restarted. </footer>
    </div>
  );
}

export default App;

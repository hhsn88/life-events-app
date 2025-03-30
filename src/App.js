import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css'; // Import the CSS file

// --- Configuration ---
// Read from environment variables provided by Create React App
const CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const API_KEY = process.env.REACT_APP_GOOGLE_API_KEY;
const SPREADSHEET_ID = process.env.REACT_APP_GOOGLE_SPREADSHEET_ID;

// *** Add console log to check loaded values ***
console.log('Loaded Client ID:', CLIENT_ID ? 'Exists' : 'MISSING');
console.log('Loaded API Key:', API_KEY ? 'Exists' : 'MISSING');
console.log('Loaded Spreadsheet ID:', SPREADSHEET_ID || 'MISSING/UNDEFINED');

const SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";

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

  const tokenClient = useRef(null);
  const isSilentSigninAttempt = useRef(false);

  // *** Add an initial check for essential config ***
  useEffect(() => {
    // Check only once on mount
    if (!CLIENT_ID || !API_KEY || !SPREADSHEET_ID) {
      setError("Configuration Error: Ensure REACT_APP_GOOGLE_CLIENT_ID, REACT_APP_GOOGLE_API_KEY, and REACT_APP_GOOGLE_SPREADSHEET_ID are set in your .env file and the server was restarted.");
      setIsLoading(false);
      // Prevent further initialization if config is missing
      setIsGapiReady(false);
      setIsGisReady(false);
    }
  }, []); // Empty dependency array ensures this runs only once


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
  // fetchUserProfile and fetchTopics now return promises
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
          return Promise.resolve(); // Indicate success
      } catch (err) {
          console.error("Error fetching user profile:", err); const errorMsg = `Could not fetch profile: ${err.result?.error?.message || err.message}`; setError(errorMsg);
          if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching profile, signing out.", err.status); setError(`Auth error fetching profile (${err.status}).`); handleSignOutClick(); }
          else { console.warn("Non-auth error fetching profile.", err.status); }
          console.log("fetchUserProfile finished with error.");
          return Promise.reject(err); // Indicate failure
      }
  }, [handleSignOutClick]);

  // *** fetchTopics: Accepts signedInStatus argument, removed isSignedIn from deps ***
  const fetchTopics = useCallback(async (isInitialLoad = false, signedInStatus) => {
    console.log(`Attempting to fetch topics... (Signed-in status passed: ${signedInStatus})`);
    if (!SPREADSHEET_ID) { setError("Spreadsheet ID is missing."); return Promise.reject("Spreadsheet ID missing"); }
    // Use the passed argument for the check
    if (!signedInStatus || !window.gapi?.client?.sheets) {
        console.log(`Fetch topics skipped (Check failed: signedInStatus=${signedInStatus}, sheetsReady=${!!window.gapi?.client?.sheets}).`);
        return Promise.resolve(); // Resolve silently if skipped
    }

    console.log("Fetching topics list...");
    if (!isInitialLoad) setIsFetchingTopics(true); // Use specific loading state only for manual refresh
    setError(null);
    try {
      const response = await window.gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID, fields: 'sheets(properties(title,sheetId))' });
      const sheets = response.result.sheets || [];
      const topicData = sheets.map(sheet => ({ title: sheet.properties.title, sheetId: sheet.properties.sheetId }));
      setTopics(topicData);
      console.log("Topics fetched and state updated:", topicData);

      // This logic might run before selectedTopic state from previous render is available,
      // so we check against the current selectedTopic state directly.
      const currentSelectedTopicExists = topicData.some(t => t.title === selectedTopic);
      if ((!currentSelectedTopicExists || !selectedTopic) && topicData.length > 0) {
          console.log("Updating selected topic to first in list:", topicData[0].title);
          setSelectedTopic(topicData[0].title);
      } else if (topicData.length === 0) {
          console.log("No topics found, clearing selection.");
          setSelectedTopic('');
      }
      console.log("fetchTopics finished successfully.");
      return Promise.resolve(); // Indicate success
    } catch (err) {
      console.error("Error fetching topics:", err); const errorMsg = `Error fetching topics: ${err.result?.error?.message || err.message}.`; setError(errorMsg);
       if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching topics, signing out.", err.status); setError("Auth error fetching topics."); handleSignOutClick(); }
       else if (err.status === 404) { console.warn("Spreadsheet not found.", err.status); setError(`Spreadsheet not found.`); }
       else { console.warn("Non-auth/404 error fetching topics.", err.status); }
       console.log("fetchTopics finished with error.");
       return Promise.reject(err); // Indicate failure
    } finally {
      if (!isInitialLoad) setIsFetchingTopics(false);
      // Main isLoading is handled by the calling effect now for initial load
    }
  // Keep selectedTopic for internal logic, handleSignOutClick for error handling
  }, [handleSignOutClick, selectedTopic]);

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
  }, []); // API_KEY is stable

  // *** Updated GIS Client Initialization: Callback ONLY sets state ***
  const initializeGisClient = useCallback(() => {
    if (!CLIENT_ID) { console.error("Client ID missing"); return; }
    console.log("Initializing GIS client...");
    try {
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID, scope: SCOPES,
            callback: (tokenResponse) => {
                console.log("GIS Token Callback received:", tokenResponse);
                isSilentSigninAttempt.current = false;
                if (tokenResponse && tokenResponse.access_token) {
                    console.log("GIS Token obtained successfully.");
                    window.gapi.client.setToken({ access_token: tokenResponse.access_token });
                    // Set signed-in state. The useEffect depending on isSignedIn will fetch data.
                    setIsSignedIn(true);
                    console.log("Set isSignedIn = true.");
                    // Data fetching is now handled by the useEffect watching isSignedIn
                } else {
                    console.error("GIS Token response error or missing token:", tokenResponse);
                    setError("Failed to obtain access token from Google.");
                    setIsSignedIn(false); setIsLoading(false); // Stop loading on token error
                }
            },
            error_callback: (error) => {
                console.warn("GIS Token Client Error Object:", error);
                const wasSilentAttempt = isSilentSigninAttempt.current;
                isSilentSigninAttempt.current = false;
                const silentFailureTypes = ['popup_closed', 'immediate_failed', 'user_cancel', 'opt_out_or_no_session', 'suppressed_by_user'];
                const isKnownSilentFailure = error.type && silentFailureTypes.includes(error.type);
                const treatAsSilent = wasSilentAttempt && (isKnownSilentFailure || error.type === 'popup_failed_to_open');
                if (treatAsSilent) { console.log(`Silent sign-in failed (Reason: ${error.type}).`); }
                else { setError(`Google Sign-In Error: ${error.type || 'popup_failed_to_open'}`); }
                setIsSignedIn(false); setIsLoading(false); // Stop loading on error
            }
        });
        setIsGisReady(true);
        console.log("GIS Token Client initialized successfully.");
    } catch (err) {
        console.error("Error initializing GIS Token Client:", err);
        setError(`Error initializing Google Sign-In: ${err.message || JSON.stringify(err)}`);
        setIsGisReady(false); setIsLoading(false);
    }
  // Removed fetchUserProfile, fetchTopics from dependencies
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
  // initializeGisClient is stable, error dependency added
  }, [initializeGisClient, error]);


  // --- Effects ---
  useEffect(() => { // Config Check Effect
    if (!CLIENT_ID || !API_KEY || !SPREADSHEET_ID) {
      setError("Configuration Error: Ensure REACT_APP_GOOGLE_CLIENT_ID, REACT_APP_GOOGLE_API_KEY, and REACT_APP_GOOGLE_SPREADSHEET_ID are set in your .env file and the server was restarted.");
      setIsLoading(false); setIsGapiReady(false); setIsGisReady(false);
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
  }, [loadGapiScript, loadGisScript, error]);

  useEffect(() => { // Silent Sign-in Attempt Effect
    if (error?.startsWith("Configuration Error") || !isGapiReady || !isGisReady) return;
    console.log(`Readiness effect: isGapiReady=${isGapiReady}, isGisReady=${isGisReady}`);
    // Only attempt silent sign-in if NOT already signed in
    if (!isSignedIn) {
        console.log("Attempting silent sign-in after short delay...");
        const timerId = setTimeout(() => {
            if (tokenClient.current) {
              console.log("Setting silent sign-in flag and calling requestAccessToken with prompt: 'none'");
              isSilentSigninAttempt.current = true;
              setIsLoading(true); // Set loading before the attempt
              tokenClient.current.requestAccessToken({ prompt: 'none' });
            } else { console.error("Token client not ready for silent sign-in attempt."); setIsLoading(false); }
        }, 100);
        return () => clearTimeout(timerId);
    } else {
        // If already signed in, ensure loading is false
        // This might happen if explicit sign-in completed before this effect ran
        setIsLoading(false);
    }
  }, [isGapiReady, isGisReady, error, isSignedIn]);

  // *** useEffect to fetch data when isSignedIn becomes true ***
  useEffect(() => {
      // Only run if signed in AND GAPI client is ready
      if (isSignedIn && isGapiReady) {
          console.log("isSignedIn is true and GAPI ready, fetching initial data...");
          setIsLoading(true); // Set loading true when starting fetches
          // Pass the current isSignedIn status explicitly to fetchTopics
          Promise.allSettled([fetchUserProfile(), fetchTopics(true, true)]) // Pass true for initial load, true for signedInStatus
              .then((results) => {
                  console.log("Initial fetchUserProfile/fetchTopics settled:", results);
                  results.forEach((result, index) => {
                      if (result.status === 'rejected') {
                          console.error(`Initial fetch ${index === 0 ? 'profile' : 'topics'} failed:`, result.reason);
                          // Error state should already be set by the fetch functions
                      }
                  });
              })
              .finally(() => {
                  console.log("Setting main isLoading to false after initial fetches triggered by isSignedIn.");
                  setIsLoading(false); // Set loading false AFTER fetches complete
              });
      } else if (!isSignedIn) {
          // If signed out, ensure loading is false (might already be false, but good practice)
          setIsLoading(false);
      }
      // This effect runs when isSignedIn or isGapiReady changes
  }, [isSignedIn, isGapiReady, fetchUserProfile, fetchTopics]); // Dependencies


  const fetchEvents = useCallback(async () => {
    if (!SPREADSHEET_ID) { setError("Spreadsheet ID is missing."); return; }
    console.log(`Attempting to fetch events for topic: ${selectedTopic}`);
    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) { console.log("Fetch events skipped."); setEvents([]); return; }
    console.log(`Fetching events for topic: ${selectedTopic}`);
    setIsFetchingEvents(true); setError(null);
    try {
      const range = `${selectedTopic}!A2:B`;
      const response = await window.gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: range });
      const values = response.result.values || [];
      const loadedEvents = values.map((row, index) => ({ id: `${selectedTopic}-${index}`, timestamp: row[0] || '', description: row[1] || '', rowNum: index + 2 })).sort((a, b) => { const dateA = new Date(a.timestamp); const dateB = new Date(b.timestamp); if (isNaN(dateA)) return 1; if (isNaN(dateB)) return -1; return dateB - dateA; });
      setEvents(loadedEvents);
    } catch (err) {
      console.error("Error fetching events:", err);
       const errorMessage = err.result?.error?.message || '';
       if (err.status === 400 && (errorMessage.includes('Unable to parse range') || errorMessage.includes('exceeds grid limits'))) { console.log(`Sheet "${selectedTopic}" is likely empty/new.`); setEvents([]); }
       else { const errorMsg = `Error fetching events: ${errorMessage}`; setError(errorMsg); if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching events.", err.status); setError("Auth error fetching events."); handleSignOutClick(); } else { console.warn("Non-auth/grid error fetching events.", err.status); } }
    } finally { console.log("fetchEvents finished."); setIsFetchingEvents(false); }
  }, [selectedTopic, isSignedIn, handleSignOutClick]);

  const fetchTopicHeaders = useCallback(async (topicTitle) => {
      if (!SPREADSHEET_ID) { setError("Spreadsheet ID is missing."); return; }
      console.log(`Attempting to fetch headers for topic: ${topicTitle}`);
      if (!topicTitle || !isSignedIn || !window.gapi?.client?.sheets) { console.log("Fetch headers skipped."); setCurrentTopicHeaders([]); return; }
      console.log(`Fetching headers for topic: ${topicTitle}`);
      setIsFetchingHeaders(true); setError(null);
      try {
          const range = `${topicTitle}!1:1`;
          const response = await window.gapi.client.sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: range });
          const headers = response.result.values?.[0] || [];
          setCurrentTopicHeaders(headers);
      } catch (err) {
          console.error("Error fetching topic headers:", err); const errorMsg = `Error fetching headers: ${err.result?.error?.message || err.message}`; setError(errorMsg);
          setCurrentTopicHeaders([]);
          if (err.status === 401 || err.status === 403) { console.warn("Auth error fetching headers.", err.status); setError("Auth error fetching headers."); handleSignOutClick(); }
          else { console.warn("Non-auth error fetching headers.", err.status); }
      } finally { console.log("fetchTopicHeaders finished."); setIsFetchingHeaders(false); }
  }, [isSignedIn, handleSignOutClick]);

  useEffect(() => { // Effect for selectedTopic change
    console.log(`Selected topic/signedIn effect: selectedTopic=${selectedTopic}, isSignedIn=${isSignedIn}`);
    if (selectedTopic && isSignedIn) { fetchEvents(); fetchTopicHeaders(selectedTopic); setNewEventData({}); }
    else { console.log("Clearing events list and headers."); setEvents([]); setCurrentTopicHeaders([]); setNewEventData({}); }
  }, [selectedTopic, isSignedIn, fetchEvents, fetchTopicHeaders]);


  // --- Action Handlers (Memoized) ---
  const handleAuthClick = useCallback(() => {
    if (error?.startsWith("Configuration Error")) return;
    console.log("handleAuthClick called");
    setError(null);
    if (!tokenClient.current) { setError("Google Sign-In is not ready yet."); setIsLoading(false); return; }
    console.log("Requesting token access via GIS (with consent prompt)..."); setIsLoading(true);
    isSilentSigninAttempt.current = false;
    tokenClient.current.requestAccessToken({ prompt: 'consent' });
  }, [error]);

  const handleAddTopic = useCallback(async (e) => {
    e.preventDefault(); if (!SPREADSHEET_ID) { setError("Spreadsheet ID is missing."); return; }
    console.log("handleAddTopic called");
    const trimmedTopicName = newTopicName.trim(); const trimmedColumns = newTopicColumns.trim();
    if (!trimmedTopicName || !isSignedIn || !window.gapi?.client?.sheets) { setError("Topic name cannot be empty, or not signed in/ready."); return; }
    if (topics.some(topic => topic.title === trimmedTopicName)) { setError(`Topic "${trimmedTopicName}" already exists.`); return; }
    const userColumns = trimmedColumns ? trimmedColumns.split(',').map(col => col.trim()).filter(Boolean) : ['Event Description'];
    const finalHeaders = ["Timestamp", ...userColumns]; const columnCount = finalHeaders.length;
    console.log(`Adding topic: ${trimmedTopicName} with columns: ${finalHeaders.join(', ')}`);
    setIsLoading(true); setError(null); // Use main loading state for this action
    try {
      const addSheetRequest = { requests: [ { addSheet: { properties: { title: trimmedTopicName, gridProperties: { rowCount: 1, columnCount: columnCount } } } } ] };
      const response = await window.gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: addSheetRequest });
      const newSheetProperties = response.result.replies?.[0]?.addSheet?.properties; const newSheetId = newSheetProperties?.sheetId;
      if (!newSheetId && newSheetId !== 0) { throw new Error("Could not get sheetId for new sheet."); }
      await window.gapi.client.sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${trimmedTopicName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [finalHeaders] } });
      setNewTopicName(''); setNewTopicColumns('Event Description'); setShowAddTopic(false);
      const newTopic = { title: trimmedTopicName, sheetId: newSheetId };
      setTopics(prevTopics => [...prevTopics, newTopic]);
      setSelectedTopic(trimmedTopicName);
    } catch (err) {
      console.error("Error adding topic:", err); const errorMsg = `Error adding topic: ${err.result?.error?.message || err.message}`; setError(errorMsg);
      if (err.status === 401 || err.status === 403) { console.warn("Auth error adding topic.", err.status); setError("Auth error adding topic."); handleSignOutClick(); }
      else { console.warn("Non-auth error adding topic.", err.status); }
    } finally { console.log("handleAddTopic finished."); setIsLoading(false); } // Stop main loading
  }, [newTopicName, newTopicColumns, isSignedIn, topics, handleSignOutClick]);

  const handleAddEvent = useCallback(async (e) => {
    e.preventDefault(); if (!SPREADSHEET_ID) { setError("Spreadsheet ID is missing."); return; }
    console.log("handleAddEvent called");
    if (currentTopicHeaders.length === 0) { setError("Topic headers not loaded."); return; }
    const hasDynamicData = Object.values(newEventData).some(val => val && val.trim() !== '');
    const isTimestampOnly = currentTopicHeaders.length === 1;
    if (!isTimestampOnly && !hasDynamicData) { setError(`Please fill in at least one event detail.`); return; }
    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) { setError("Cannot add event: Not ready."); return; }
    console.log(`Adding event to topic: ${selectedTopic}`);
    setIsLoading(true); setError(null); // Use main loading state
    try {
      let timestamp = formatTimestamp(); const trimmedTime = newEventCustomTime.trim();
      if (trimmedTime) {
          if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmedTime)) { const parsedDate = new Date(trimmedTime); if (!isNaN(parsedDate.getTime())) { timestamp = formatTimestamp(parsedDate); } else { setError("Invalid custom date format."); setIsLoading(false); return; } }
          else { setError("Invalid custom date format."); setIsLoading(false); return; }
      }
      const rowData = currentTopicHeaders.map((header, index) => (index === 0 ? timestamp : (newEventData[header] || '')));
      const values = [rowData]; const body = { values: values };
      await window.gapi.client.sheets.spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: selectedTopic, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', resource: body });
      setNewEventCustomTime(''); setNewEventData({}); setShowAddEvent(false);
      await fetchEvents();
    } catch (err) {
      console.error("Error adding event:", err); const errorMsg = `Error adding event: ${err.result?.error?.message || err.message}`; setError(errorMsg);
      if (err.status === 401 || err.status === 403) { console.warn("Auth error adding event.", err.status); setError("Auth error adding event."); handleSignOutClick(); }
      else { console.warn("Non-auth error adding event.", err.status); }
    } finally { console.log("handleAddEvent finished."); setIsLoading(false); } // Stop main loading
  }, [selectedTopic, isSignedIn, newEventCustomTime, fetchEvents, handleSignOutClick, currentTopicHeaders, newEventData]);

  const handleDeleteEvent = useCallback(async (eventToDelete, sheetId) => {
      if (!SPREADSHEET_ID) { setError("Spreadsheet ID is missing."); return; }
      if (!eventToDelete || sheetId === undefined || !isSignedIn || !window.gapi?.client?.sheets) { setError("Cannot delete event: missing data/state."); return; }
      if (!window.confirm(`Delete event: "${eventToDelete.description}"?`)) { return; }
      console.log(`Deleting row: ${eventToDelete.rowNum} from sheetId: ${sheetId}`);
      setIsLoading(true); setError(null); // Use main loading state
      try {
          const deleteRequest = { requests: [ { deleteDimension: { range: { sheetId: sheetId, dimension: "ROWS", startIndex: eventToDelete.rowNum - 1, endIndex: eventToDelete.rowNum } } } ] };
          await window.gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: deleteRequest });
          setEvents(prevEvents => prevEvents.filter(event => event.id !== eventToDelete.id));
      } catch (err) {
          console.error("Error deleting event:", err); const errorMsg = `Error deleting event: ${err.result?.error?.message || err.message}`; setError(errorMsg);
          if (err.status === 401 || err.status === 403) { console.warn("Auth error deleting event.", err.status); setError("Auth error deleting event."); handleSignOutClick(); }
          else { console.warn("Non-auth error deleting event.", err.status); }
      } finally { console.log("handleDeleteEvent finished."); setIsLoading(false); } // Stop main loading
  }, [isSignedIn, handleSignOutClick]); // Dependencies

  const getCurrentSheetId = () => topics.find(t => t.title === selectedTopic)?.sheetId;

  const handleNewEventDataChange = (header, value) => setNewEventData(prevData => ({ ...prevData, [header]: value }));

  // --- UI Rendering ---
  // Use main isLoading for overall loading state, specific ones for targeted feedback
  const showAppLoading = isLoading && !error; // Show main loader only if no error and isLoading is true

  return (
    <div className="app-container">
      <div className="content-wrapper">
        {/* Header */}
        <header className="header"> <h1>Sheets Event Logger</h1> <div className="auth-controls"> {showAppLoading && <div className="loader">Loading...</div>} {isGapiReady && isGisReady && !isSignedIn && !showAppLoading && ( <button onClick={handleAuthClick} disabled={showAppLoading} className="button button-primary"> Sign In with Google </button> )} {isSignedIn && currentUser && ( <div className="user-info"> <span className="user-details">{currentUser.name} ({currentUser.email})</span> <button onClick={handleSignOutClick} className="button button-danger">Sign Out</button> </div> )} </div> </header>
        {/* Error Display */}
        {error && ( <div className="error-box"> <strong>Error: </strong> <span>{error}</span> <button onClick={() => setError(null)} className="close-button">&times;</button> </div> )}
        {/* Initializing Message - shown only if libs aren't ready AND not loading AND no error */}
        {(!isGapiReady || !isGisReady) && !showAppLoading && !error && ( <p className="status-message">Initializing Google Services...</p> )}

        {/* Main Content Area (Signed In) */}
        {isSignedIn && !showAppLoading && ( // Don't show main content if initial loading is happening
          <main>
            {/* Topic Section */}
            <section className="section">
              <div className="section-header"> <h2>Topics</h2> <div className="controls"> <button onClick={() => fetchTopics(false, isSignedIn)} disabled={isFetchingTopics || isLoading} title="Refresh Topics" className="button button-icon"> <span role="img" aria-label="Refresh Topics">🔄</span> </button> <button onClick={() => setShowAddTopic(!showAddTopic)} className="button button-secondary" disabled={isLoading}> + Add Topic </button> </div> </div>
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
        {/* Sign In Prompt - shown only if libs are ready, not signed in, and not loading */}
        {isGapiReady && isGisReady && !isSignedIn && !showAppLoading && ( <p className="status-message">Please sign in to manage your event logs.</p> )}
      </div>
      <footer className="footer"> Ensure Client ID, API Key, and Spreadsheet ID are set in .env and server restarted. </footer>
    </div>
  );
}

export default App;

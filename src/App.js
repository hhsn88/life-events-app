import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css'; // Import the CSS file

// --- Configuration ---
const CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const API_KEY = process.env.REACT_APP_GOOGLE_API_KEY;
const SPREADSHEET_ID = process.env.REACT_APP_GOOGLE_SPREADSHEET_ID;

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
  const [isLoading, setIsLoading] = useState(true); // General loading state
  const [isFetchingEvents, setIsFetchingEvents] = useState(false); // Specific loading for events
  const [isFetchingHeaders, setIsFetchingHeaders] = useState(false); // Specific loading for headers
  const [isGapiReady, setIsGapiReady] = useState(false);
  const [isGisReady, setIsGisReady] = useState(false);
  const [error, setError] = useState(null);
  const [topics, setTopics] = useState([]); // Stores { title, sheetId }
  const [selectedTopic, setSelectedTopic] = useState(''); // Stores title string
  const [events, setEvents] = useState([]);
  // State for topic headers
  const [currentTopicHeaders, setCurrentTopicHeaders] = useState([]);
  const [showAddTopic, setShowAddTopic] = useState(false);
  const [newTopicName, setNewTopicName] = useState('');
  const [newTopicColumns, setNewTopicColumns] = useState('Event Description');
  const [showAddEvent, setShowAddEvent] = useState(false);
  // State for event data (timestamp + dynamic fields)
  const [newEventCustomTime, setNewEventCustomTime] = useState('');
  const [newEventData, setNewEventData] = useState({}); // Stores { headerName: value }

  const tokenClient = useRef(null);

  // --- Sign Out Handler ---
  const handleSignOutClick = useCallback(() => {
    console.log("handleSignOutClick called");
    const token = window.gapi?.client?.getToken();
    if (token !== null) {
      void window.google?.accounts?.oauth2?.revoke(token.access_token, () => {
        console.log('Access token revoked');
        void window.gapi?.client?.setToken(null);
        setIsSignedIn(false); setCurrentUser(null); setTopics([]);
        setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]); // Reset headers
        setNewEventData({}); // Reset event data
        setError(null); setIsLoading(false);
      });
    } else {
        console.log("handleSignOutClick: No token found, resetting state.");
        setIsSignedIn(false); setCurrentUser(null); setTopics([]);
        setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]); // Reset headers
        setNewEventData({}); // Reset event data
        setError(null); setIsLoading(false);
    }
  }, []);


  // --- API Callbacks (Memoized) ---
  const fetchUserProfile = useCallback(async () => {
      console.log("Attempting to fetch user profile...");
      // Guard clauses for API readiness
      if (!window.gapi?.client) { console.warn("GAPI client not ready for fetchUserProfile"); return; }

      // Load People API if needed
      if (!window.gapi?.client?.people) {
          try {
              console.log("Loading People API...");
              await window.gapi?.client?.load('https://people.googleapis.com/$discovery/rest?version=v1');
              console.log("People API loaded or already available.");
          } catch (loadErr) {
              console.error("Error loading People API:", loadErr);
              setError(`Could not load People API: ${loadErr.message}`);
              setIsLoading(false); return;
          }
      }
      if (!window.gapi?.client?.people) {
           console.error("People API client library not available after load attempt.");
           setError("People API client library not available.");
           setIsLoading(false); return;
      }
      try {
          console.log("Calling people.people.get (me)...");
          const response = await window.gapi.client.people.people.get({
              resourceName: 'people/me', personFields: 'names,emailAddresses',
          });
          console.log("User profile response received:", response.result);
          const profile = response.result;
          const primaryName = profile.names?.find(n => n.metadata?.primary)?.displayName ??
                              (profile.names?.length > 0 ? profile.names[0].displayName : 'User');
          const primaryEmail = profile.emailAddresses?.find(e => e.metadata?.primary)?.value ??
                               (profile.emailAddresses?.length > 0 ? profile.emailAddresses[0].value : 'No email');
          setCurrentUser({ name: primaryName, email: primaryEmail });
          console.log("User profile state updated.");
      } catch (err) {
          console.error("Error fetching user profile:", err);
          const errorMsg = `Could not fetch user profile: ${err.result?.error?.message || err.message}`;
          setError(errorMsg);
          if (err.status === 401 || err.status === 403) {
              console.warn("Authorization error fetching profile, signing out.", err.status);
              setError(`Authorization error fetching profile (${err.status}). Please ensure People API is enabled and scopes are granted. Signing out.`);
              handleSignOutClick();
          } else {
              console.warn("Non-auth error fetching profile, not signing out.", err.status);
          }
      } finally {
          console.log("fetchUserProfile finished.");
      }
  }, [handleSignOutClick]);

  const fetchTopics = useCallback(async () => {
    console.log("Attempting to fetch topics (including sheetId)...");
    if (!isSignedIn || !window.gapi?.client?.sheets) {
      console.log("Fetch topics skipped: Not signed in or Sheets API not ready."); return;
    }
    if (!SPREADSHEET_ID || SPREADSHEET_ID === 'YOUR_SPREADSHEET_ID') {
      setError("Spreadsheet ID is not configured."); setIsLoading(false); return;
    }

    console.log("Fetching topics...");
    setIsLoading(true); setError(null);
    try {
      console.log("Calling sheets.spreadsheets.get for titles and sheetIds...");
      const response = await window.gapi.client.sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID, fields: 'sheets(properties(title,sheetId))',
      });
      console.log("Topics response received:", response.result);
      const sheets = response.result.sheets || [];
      const topicData = sheets.map(sheet => ({
          title: sheet.properties.title, sheetId: sheet.properties.sheetId
      }));
      setTopics(topicData);
      console.log("Topics fetched and state updated:", topicData);

      const currentSelectedTopicExists = topicData.some(t => t.title === selectedTopic);
      if (!currentSelectedTopicExists && topicData.length > 0) {
          setSelectedTopic(topicData[0].title);
      } else if (topicData.length === 0) {
          setSelectedTopic('');
      }
    } catch (err) {
      console.error("Error fetching topics:", err);
      const errorMsg = `Error fetching topics: ${err.result?.error?.message || err.message}.`;
      setError(errorMsg);
       if (err.status === 401 || err.status === 403) {
           console.warn("Authorization error fetching topics, signing out.", err.status);
           setError("Authorization error fetching topics. Please sign in again.");
           handleSignOutClick();
       } else if (err.status === 404) {
           console.warn("Spreadsheet not found error.", err.status);
           setError(`Spreadsheet not found. Check SPREADSHEET_ID.`);
       } else {
           console.warn("Non-auth/404 error fetching topics, not signing out.", err.status);
       }
    } finally {
      console.log("fetchTopics finished.");
      setIsLoading(false);
    }
  }, [isSignedIn, handleSignOutClick, selectedTopic]);

  // --- Google API Initialization Callbacks (Memoized) ---
  const initializeGapiClient = useCallback(async () => {
    console.log("Initializing GAPI client...");
    if (!API_KEY || API_KEY === 'YOUR_GOOGLE_API_KEY') {
        setError("API Key is not configured."); setIsLoading(false); setIsGapiReady(false); return;
    }
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
    console.log("Initializing GIS client...");
    if (!CLIENT_ID || CLIENT_ID === 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com') {
        setError("Client ID is not configured."); setIsGisReady(false); setIsLoading(false); return;
    }
    try {
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID, scope: SCOPES,
            callback: (tokenResponse) => {
                console.log("GIS Token Callback received:", tokenResponse);
                if (tokenResponse && tokenResponse.access_token) {
                    console.log("GIS Token obtained successfully.");
                    window.gapi.client.setToken({ access_token: tokenResponse.access_token });
                    setIsSignedIn(true);
                    console.log("Set isSignedIn = true. Fetching profile and topics...");
                    fetchUserProfile();
                    fetchTopics();
                } else {
                    console.error("GIS Token response error or missing token:", tokenResponse);
                    setError("Failed to obtain access token from Google.");
                    setIsSignedIn(false); setIsLoading(false);
                }
            },
            error_callback: (error) => {
                console.error("GIS Token Client Error:", error);
                setError(`Google Sign-In Error: ${error.type || 'Unknown error'}`);
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
  }, [fetchUserProfile, fetchTopics]); // Dependencies

  const loadGapiScript = useCallback(() => {
    console.log("Loading GAPI script...");
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true; script.defer = true;
    script.onload = () => {
      console.log("GAPI script loaded.");
      if (window.gapi) { window.gapi.load('client', initializeGapiClient); }
      else { setError("GAPI script loaded but window.gapi is not available."); console.error("window.gapi not found after script load."); }
    };
    script.onerror = () => setError("Failed to load Google API script.");
    document.body.appendChild(script); return script;
  }, [initializeGapiClient]);

  const loadGisScript = useCallback(() => {
    console.log("Loading GIS script...");
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true; script.defer = true;
    script.onload = () => {
      console.log("GIS script loaded.");
      if (window.google?.accounts?.oauth2) { initializeGisClient(); }
      else { setError("GIS script loaded but google.accounts.oauth2 is not available."); console.error("google.accounts.oauth2 not found after script load."); }
    };
    script.onerror = () => setError("Failed to load Google Identity Services script.");
    document.body.appendChild(script); return script;
  }, [initializeGisClient]); // Depends on initializeGisClient


  // --- Effects ---
  useEffect(() => {
    console.log("Mount effect: Loading scripts.");
    const gapiScript = loadGapiScript();
    const gisScript = loadGisScript();
    return () => {
      console.log("Cleanup effect: Removing scripts.");
      if (gapiScript?.parentNode) document.body.removeChild(gapiScript);
      if (gisScript?.parentNode) document.body.removeChild(gisScript);
    };
  }, [loadGapiScript, loadGisScript]); // Load scripts on mount

  useEffect(() => {
    console.log(`Readiness effect: isGapiReady=${isGapiReady}, isGisReady=${isGisReady}`);
    if (isGapiReady && isGisReady) {
      console.log("GAPI and GIS ready. Checking for existing token...");
      const token = window.gapi?.client?.getToken();
       if (token && token.access_token) {
           console.log("Found existing token, attempting to use it.");
           setIsSignedIn(true);
           console.log("Set isSignedIn = true from existing token. Fetching profile and topics...");
           fetchUserProfile();
           fetchTopics();
       } else {
           console.log("No existing token found.");
           setIsLoading(false);
       }
    }
  }, [isGapiReady, isGisReady, fetchUserProfile, fetchTopics]); // Check readiness

  // *** fetchEvents: Handles empty/new sheets ***
  const fetchEvents = useCallback(async () => {
    console.log(`Attempting to fetch events for topic: ${selectedTopic}`);
    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) {
      console.log("Fetch events skipped: No topic, not signed in, or Sheets API not ready.");
      setEvents([]); return;
    }

    console.log(`Fetching events for topic: ${selectedTopic}`);
    // Use specific loading state
    setIsFetchingEvents(true); setError(null);
    try {
      const range = `${selectedTopic}!A2:B`; // Still only fetch first two columns for display
      console.log(`Calling sheets.spreadsheets.values.get for range: ${range}`);
      const response = await window.gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: range,
      });
      console.log("Events response received:", response.result);

      const values = response.result.values || [];
      const loadedEvents = values.map((row, index) => ({
        id: `${selectedTopic}-${index}`, timestamp: row[0] || '', description: row[1] || '', rowNum: index + 2
      })).sort((a, b) => {
          const dateA = new Date(a.timestamp); const dateB = new Date(b.timestamp);
          if (isNaN(dateA)) return 1; if (isNaN(dateB)) return -1;
          return dateB - dateA; // Descending
      });
      setEvents(loadedEvents);
      console.log("Events fetched and state updated:", loadedEvents.length);

    } catch (err) {
      console.error("Error fetching events:", err);
       const errorMessage = err.result?.error?.message || '';
       if (err.status === 400 && (errorMessage.includes('Unable to parse range') || errorMessage.includes('exceeds grid limits'))) {
          console.log(`Sheet "${selectedTopic}" is likely empty or new. Setting events to empty array.`);
          setEvents([]); // Treat as empty
      } else {
          const errorMsg = `Error fetching events for "${selectedTopic}": ${errorMessage}`; setError(errorMsg);
           if (err.status === 401 || err.status === 403) {
               console.warn("Authorization error fetching events, signing out.", err.status);
               setError("Authorization error fetching events. Please sign in again."); handleSignOutClick();
           } else { console.warn("Non-auth/grid error fetching events, not signing out.", err.status); }
      }
    } finally {
      console.log("fetchEvents finished.");
      setIsFetchingEvents(false); // Use specific loading state
    }
  }, [selectedTopic, isSignedIn, handleSignOutClick]); // Dependencies

  // *** New: Fetch Topic Headers ***
  const fetchTopicHeaders = useCallback(async (topicTitle) => {
      console.log(`Attempting to fetch headers for topic: ${topicTitle}`);
      if (!topicTitle || !isSignedIn || !window.gapi?.client?.sheets) {
          console.log("Fetch headers skipped: No topic, not signed in, or Sheets API not ready.");
          setCurrentTopicHeaders([]); // Reset headers if skipped
          return;
      }

      console.log(`Fetching headers for topic: ${topicTitle}`);
      setIsFetchingHeaders(true); setError(null); // Use specific loading state
      try {
          const range = `${topicTitle}!1:1`; // Get the first row
          console.log(`Calling sheets.spreadsheets.values.get for range: ${range}`);
          const response = await window.gapi.client.sheets.spreadsheets.values.get({
              spreadsheetId: SPREADSHEET_ID, range: range,
          });
          console.log("Headers response received:", response.result);
          const headers = response.result.values?.[0] || []; // Get the first row's values
          setCurrentTopicHeaders(headers);
          console.log("Topic headers fetched and state updated:", headers);
      } catch (err) {
          console.error("Error fetching topic headers:", err);
          const errorMsg = `Error fetching headers for "${topicTitle}": ${err.result?.error?.message || err.message}`;
          setError(errorMsg);
          setCurrentTopicHeaders([]); // Reset headers on error
          // Don't sign out for header fetch errors unless it's auth-related
          if (err.status === 401 || err.status === 403) {
              console.warn("Authorization error fetching headers, signing out.", err.status);
              setError("Authorization error fetching headers. Please sign in again.");
              handleSignOutClick();
          } else {
               console.warn("Non-auth error fetching headers.", err.status);
           }
      } finally {
          console.log("fetchTopicHeaders finished.");
          setIsFetchingHeaders(false); // Use specific loading state
      }
  }, [isSignedIn, handleSignOutClick]); // Dependencies

  // *** useEffect for selectedTopic: Now fetches headers too ***
  useEffect(() => {
    console.log(`Selected topic/signedIn effect: selectedTopic=${selectedTopic}, isSignedIn=${isSignedIn}`);
    if (selectedTopic && isSignedIn) {
      // Fetch both events and headers when topic changes
      fetchEvents();
      fetchTopicHeaders(selectedTopic);
      setNewEventData({}); // Reset event form data when topic changes
    } else {
      console.log("Clearing events list and headers.");
      setEvents([]);
      setCurrentTopicHeaders([]); // Clear headers if no topic selected or signed out
      setNewEventData({}); // Reset event form data
    }
  // Add fetchTopicHeaders to dependencies
  }, [selectedTopic, isSignedIn, fetchEvents, fetchTopicHeaders]);


  // --- Action Handlers (Memoized) ---
  const handleAuthClick = useCallback(() => {
    console.log("handleAuthClick called");
    setError(null);
    if (!tokenClient.current) {
        setError("Google Sign-In is not ready yet."); console.error("Token client not initialized.");
        setIsLoading(false); return;
    }
    console.log("Requesting token access via GIS..."); setIsLoading(true);
    tokenClient.current.requestAccessToken({ prompt: 'consent' });
  }, []);

  const handleAddTopic = useCallback(async (e) => {
    e.preventDefault();
    console.log("handleAddTopic called");
    const trimmedTopicName = newTopicName.trim();
    const trimmedColumns = newTopicColumns.trim();

    if (!trimmedTopicName || !isSignedIn || !window.gapi?.client?.sheets) {
        setError("Topic name cannot be empty, or not signed in, or Sheets API not ready."); return;
    }
    if (topics.some(topic => topic.title === trimmedTopicName)) {
        setError(`Topic "${trimmedTopicName}" already exists.`); return;
    }

    const userColumns = trimmedColumns ? trimmedColumns.split(',').map(col => col.trim()).filter(Boolean) : ['Event Description'];
    const finalHeaders = ["Timestamp", ...userColumns];
    const columnCount = finalHeaders.length;

    console.log(`Adding topic: ${trimmedTopicName} with columns: ${finalHeaders.join(', ')}`);
    setIsLoading(true); setError(null);
    try {
      const addSheetRequest = { requests: [ { addSheet: { properties: { title: trimmedTopicName, gridProperties: { rowCount: 1, columnCount: columnCount } } } } ] };
      console.log("Calling sheets.spreadsheets.batchUpdate to add sheet...");
      const response = await window.gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: addSheetRequest });
      console.log("Add sheet request successful:", response);

      const newSheetProperties = response.result.replies?.[0]?.addSheet?.properties;
      const newSheetId = newSheetProperties?.sheetId;
      if (!newSheetId && newSheetId !== 0) { throw new Error("Could not get sheetId for the newly created sheet."); }
      console.log(`New sheet created with title: ${newSheetProperties?.title}, sheetId: ${newSheetId}`);

       console.log("Calling sheets.spreadsheets.values.update to add header...");
       await window.gapi.client.sheets.spreadsheets.values.update({
           spreadsheetId: SPREADSHEET_ID, range: `${trimmedTopicName}!A1`, valueInputOption: 'USER_ENTERED', resource: { values: [finalHeaders] },
       });
       console.log("Header added to new sheet.");

      setNewTopicName(''); setNewTopicColumns('Event Description'); setShowAddTopic(false);
      const newTopic = { title: trimmedTopicName, sheetId: newSheetId };
      setTopics(prevTopics => [...prevTopics, newTopic]);
      setSelectedTopic(trimmedTopicName); // Select new topic, triggers useEffect to fetch headers/events

    } catch (err) {
      console.error("Error adding topic:", err);
      const errorMsg = `Error adding topic: ${err.result?.error?.message || err.message}`; setError(errorMsg);
       if (err.status === 401 || err.status === 403) {
           console.warn("Authorization error adding topic, signing out.", err.status);
           setError("Authorization error adding topic. Please sign in again."); handleSignOutClick();
       } else { console.warn("Non-auth error adding topic, not signing out.", err.status); }
    } finally {
      console.log("handleAddTopic finished."); setIsLoading(false);
    }
  }, [newTopicName, newTopicColumns, isSignedIn, topics, handleSignOutClick]); // Removed fetchTopics dependency

  // *** handleAddEvent: Updated to handle dynamic columns ***
  const handleAddEvent = useCallback(async (e) => {
    e.preventDefault();
    console.log("handleAddEvent called");

    // Basic check - ensure headers are loaded before allowing add
    if (currentTopicHeaders.length === 0) {
        setError("Topic headers not loaded yet. Please wait or refresh.");
        return;
    }

    // Ensure required fields based on headers are considered (optional enhancement)
    // For now, we just check if *any* dynamic data exists or if only timestamp is needed
    const hasDynamicData = Object.values(newEventData).some(val => val && val.trim() !== '');
    const isTimestampOnly = currentTopicHeaders.length === 1; // Only "Timestamp" column

    // If only timestamp exists, no other data is needed. If more columns exist, check dynamic data.
    if (!isTimestampOnly && !hasDynamicData) {
        setError(`Please fill in at least one event detail field.`);
        // Find the first dynamic header name for a more specific message (optional)
        // const firstDataColumn = currentTopicHeaders[1];
        // setError(`"${firstDataColumn}" cannot be empty.`);
        return;
    }

    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) {
        setError("Cannot add event: No topic selected, not signed in, or Sheets API not ready.");
        return;
    }

    console.log(`Adding event to topic: ${selectedTopic}`);
    setIsLoading(true); setError(null);
    try {
      // 1. Determine Timestamp
      let timestamp = formatTimestamp(); // Default to now
      const trimmedTime = newEventCustomTime.trim();
      if (trimmedTime) {
          if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmedTime)) {
              const parsedDate = new Date(trimmedTime);
              if (!isNaN(parsedDate.getTime())) { timestamp = formatTimestamp(parsedDate); }
              else {
                  setError("Invalid custom date format. Please use YYYY-MM-DD HH:MM:SS.");
                  setIsLoading(false); return;
              }
          } else {
               setError("Invalid custom date format. Please use YYYY-MM-DD HH:MM:SS.");
               setIsLoading(false); return;
          }
      }

      // 2. Construct row data based on currentTopicHeaders
      const rowData = currentTopicHeaders.map((header, index) => {
          if (index === 0) { // First column is always Timestamp
              return timestamp;
          }
          // Get value from newEventData state using header name as key
          return newEventData[header] || ''; // Default to empty string if not entered
      });

      const values = [rowData]; // API expects an array of rows
      const body = { values: values };

      console.log("Calling sheets.spreadsheets.values.append with data:", values);
      await window.gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        // Append to the sheet, let Sheets figure out the columns
        range: selectedTopic, // Just the sheet name
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        resource: body,
      });

      console.log("Event added successfully.");
      // Reset form fields
      setNewEventCustomTime('');
      setNewEventData({}); // Reset dynamic data
      setShowAddEvent(false);
      await fetchEvents(); // Refresh event list

    } catch (err) {
      console.error("Error adding event:", err);
      const errorMsg = `Error adding event: ${err.result?.error?.message || err.message}`; setError(errorMsg);
       if (err.status === 401 || err.status === 403) {
           console.warn("Authorization error adding event, signing out.", err.status);
           setError("Authorization error adding event. Please sign in again."); handleSignOutClick();
       } else { console.warn("Non-auth error adding event, not signing out.", err.status); }
    } finally {
      console.log("handleAddEvent finished."); setIsLoading(false);
    }
  // Add currentTopicHeaders and newEventData to dependencies
  }, [selectedTopic, isSignedIn, newEventCustomTime, fetchEvents, handleSignOutClick, currentTopicHeaders, newEventData]);

  const handleDeleteEvent = useCallback(async (eventToDelete, sheetId) => {
      if (!eventToDelete || sheetId === undefined || !isSignedIn || !window.gapi?.client?.sheets) {
          setError("Cannot delete event: missing data or not signed in."); return;
      }
      if (!window.confirm(`Are you sure you want to delete the event: "${eventToDelete.description}"?`)) { return; }

      console.log(`Deleting event row: ${eventToDelete.rowNum} from sheetId: ${sheetId}`);
      setIsLoading(true); setError(null);
      try {
          const deleteRequest = { requests: [ { deleteDimension: { range: { sheetId: sheetId, dimension: "ROWS", startIndex: eventToDelete.rowNum - 1, endIndex: eventToDelete.rowNum } } } ] };
          console.log("Calling sheets.spreadsheets.batchUpdate to delete row...");
          await window.gapi.client.sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, resource: deleteRequest });
          console.log(`Row ${eventToDelete.rowNum} deleted successfully.`);
          setEvents(prevEvents => prevEvents.filter(event => event.id !== eventToDelete.id));
      } catch (err) {
          console.error("Error deleting event:", err);
          const errorMsg = `Error deleting event: ${err.result?.error?.message || err.message}`; setError(errorMsg);
          if (err.status === 401 || err.status === 403) {
              console.warn("Authorization error deleting event, signing out.", err.status);
              setError("Authorization error deleting event. Please sign in again."); handleSignOutClick();
          } else { console.warn("Non-auth error deleting event, not signing out.", err.status); }
      } finally {
          console.log("handleDeleteEvent finished."); setIsLoading(false);
      }
  }, [isSignedIn, handleSignOutClick]); // Dependencies

  // Helper to get sheetId for the currently selected topic title
  const getCurrentSheetId = () => {
      const currentTopic = topics.find(t => t.title === selectedTopic);
      return currentTopic?.sheetId;
  };

  // Handler for dynamic event data inputs
  const handleNewEventDataChange = (header, value) => {
      setNewEventData(prevData => ({
          ...prevData,
          [header]: value
      }));
  };


  // --- UI Rendering ---
  // Combine loading states for general indicator
  const showGeneralLoading = isLoading || isFetchingEvents || isFetchingHeaders;

  return (
    <div className="app-container">
      <div className="content-wrapper">
        {/* Header */}
        <header className="header">
          <h1>Sheets Event Logger</h1>
          <div className="auth-controls">
            {showGeneralLoading && <div className="loader">Loading...</div>}
            {isGapiReady && isGisReady && !isSignedIn && !showGeneralLoading && (
              <button onClick={handleAuthClick} disabled={showGeneralLoading} className="button button-primary">
                Sign In with Google
              </button>
            )}
            {isSignedIn && currentUser && (
              <div className="user-info">
                 <span className="user-details">{currentUser.name} ({currentUser.email})</span>
                 <button onClick={handleSignOutClick} className="button button-danger">Sign Out</button>
              </div>
            )}
          </div>
        </header>

        {/* Error Display */}
        {error && (
          <div className="error-box">
            <strong>Error: </strong>
            <span>{error}</span>
            <button onClick={() => setError(null)} className="close-button">&times;</button>
          </div>
        )}

        {/* Initializing Message */}
        {(!isGapiReady || !isGisReady) && !error && ( <p className="status-message">Initializing Google Services...</p> )}

        {/* Main Content Area (Signed In) */}
        {isSignedIn && (
          <main>
            {/* Topic Section */}
            <section className="section">
              <div className="section-header">
                <h2>Topics</h2>
                <div className="controls">
                   <button onClick={fetchTopics} disabled={showGeneralLoading} title="Refresh Topics" className="button button-icon">
                      <span role="img" aria-label="Refresh Topics">🔄</span>
                    </button>
                    <button onClick={() => setShowAddTopic(!showAddTopic)} className="button button-secondary" disabled={showGeneralLoading}>
                       + Add Topic
                    </button>
                </div>
              </div>

              {/* Add Topic Form */}
              {showAddTopic && (
                <form onSubmit={handleAddTopic} className="form add-topic-form">
                  <div className="form-group">
                      <label htmlFor="new-topic">New Topic Name:</label>
                      <input id="new-topic" type="text" value={newTopicName} onChange={(e) => setNewTopicName(e.target.value)} placeholder="e.g., Work Meetings" required className="input-field"/>
                  </div>
                  <div className="form-group">
                      <label htmlFor="new-topic-columns">Column Headers (after Timestamp, comma-separated):</label>
                      <input id="new-topic-columns" type="text" value={newTopicColumns} onChange={(e) => setNewTopicColumns(e.target.value)} placeholder="e.g., Description, Category, Duration" className="input-field"/>
                      <p className="help-text">Defaults to "Event Description". Timestamp column is always added first.</p>
                  </div>
                  <div className="form-actions">
                    <button type="submit" disabled={isLoading} className="button button-primary">Create</button>
                    <button type="button" onClick={() => setShowAddTopic(false)} className="button button-secondary">Cancel</button>
                  </div>
                </form>
              )}

              {/* Topic Selector */}
              {topics.length > 0 ? (
                <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)} disabled={showGeneralLoading} className="select-field">
                  <option value="" disabled={selectedTopic !== ''}>-- Select a Topic --</option>
                  {topics.map(topic => ( <option key={topic.sheetId} value={topic.title}>{topic.title}</option> ))}
                </select>
              ) : (
                 !showGeneralLoading && isSignedIn && <p className="status-message">No topics found. Add one to get started!</p>
              )}
            </section>

            {/* Events Section */}
            {selectedTopic && (
              <section className="section">
                <div className="section-header">
                    <h2>Events for "{selectedTopic}"</h2>
                     <button onClick={() => setShowAddEvent(!showAddEvent)} className="button button-secondary" disabled={showGeneralLoading || isFetchingHeaders}>
                       + Add Event
                    </button>
                </div>

                {/* Add Event Form - Now Dynamic */}
                {showAddEvent && (
                    <form onSubmit={handleAddEvent} className="form add-event-form">
                        {/* Timestamp is always first */}
                        <div className="form-group">
                            <label htmlFor="new-event-time">Custom Timestamp (Optional):</label>
                            <input id="new-event-time" type="text" value={newEventCustomTime} onChange={(e) => setNewEventCustomTime(e.target.value)} placeholder={`Format: YYYY-MM-DD HH:MM:SS (e.g., ${formatTimestamp()})`} className="input-field"/>
                            <p className="help-text">Leave blank to use the current time.</p>
                        </div>

                        {/* Dynamically generate inputs for other columns */}
                        {currentTopicHeaders.slice(1).map((header, index) => (
                            <div className="form-group" key={`event-col-${index}`}>
                                <label htmlFor={`event-input-${header}`}>{header}:</label>
                                <input
                                    id={`event-input-${header}`}
                                    type="text"
                                    value={newEventData[header] || ''}
                                    onChange={(e) => handleNewEventDataChange(header, e.target.value)}
                                    className="input-field"
                                    // You might add placeholder text based on header if needed
                                    // placeholder={`Enter ${header}`}
                                />
                            </div>
                        ))}

                        <div className="form-actions">
                            <button type="submit" disabled={isLoading} className="button button-primary">Add Event</button>
                            <button type="button" onClick={() => { setShowAddEvent(false); setNewEventData({}); setNewEventCustomTime(''); }} className="button button-secondary">Cancel</button>
                        </div>
                    </form>
                )}

                {/* Event List */}
                {isFetchingEvents && <p className="status-message">Loading events...</p>}
                {!isFetchingEvents && events.length > 0 ? (
                  <ul className="event-list">
                    {events.map(event => (
                      <li key={event.id} className="event-item">
                        <div className="event-content">
                            {/* Display only first two columns for now */}
                            <p className="event-description">{event.description}</p>
                            <p className="event-timestamp">{event.timestamp}</p>
                        </div>
                        <button
                            onClick={() => handleDeleteEvent(event, getCurrentSheetId())}
                            disabled={isLoading} // Disable during any loading action
                            className="button button-delete"
                            title="Delete Event"
                            aria-label={`Delete event: ${event.description}`}
                        >
                            &times;
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                   !isFetchingEvents && isSignedIn && selectedTopic && <p className="status-message">No events found for this topic yet.</p>
                )}
                 {/* General Loading indicator can replace specific one if preferred */}
                 {/* {isLoading && isSignedIn && selectedTopic && <p className="status-message">Loading...</p>} */}
              </section>
            )}
          </main>
        )}

        {/* Sign In Prompt (Not Signed In) */}
        {!isSignedIn && isGapiReady && isGisReady && !showGeneralLoading && (
             <p className="status-message">Please sign in to manage your event logs.</p>
        )}
      </div>

      {/* Footer */}
      <footer className="footer">
          Ensure you have configured the Client ID, API Key, and Spreadsheet ID in the code.
      </footer>
    </div>
  );
}

export default App;

// App.js:
import React, { useState, useEffect, useCallback, useRef } from 'react';
import './App.css'; // Import the CSS file
import logo from './logo.svg'; // Import the SVG logo from src

// --- Configuration ---
// Read Client ID from environment variables
const CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
// SPREADSHEET_ID is managed via state and localStorage

console.log('Loaded Client ID:', CLIENT_ID ? 'Exists' : 'MISSING'); // Keep this check

const SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";
const LOCAL_STORAGE_KEY = 'sheetsEventAppSpreadsheetId'; // Key for localStorage

// --- Helper Functions ---
function formatTimestamp(date = new Date()) {
  // Formats date to 'YYYY-MM-DD HH:MM:SS'
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
  const [isGapiReady, setIsGapiReady] = useState(false); // Google API Client library ready state
  const [isGisReady, setIsGisReady] = useState(false); // Google Identity Services library ready state
  const [error, setError] = useState(null); // Stores error messages
  const [topics, setTopics] = useState([]); // Stores { title, sheetId } for spreadsheet sheets
  const [selectedTopic, setSelectedTopic] = useState(''); // Stores title string of the selected sheet
  const [events, setEvents] = useState([]); // Stores events fetched from the selected sheet
  const [currentTopicHeaders, setCurrentTopicHeaders] = useState([]); // Stores headers of the selected sheet
  const [showAddTopic, setShowAddTopic] = useState(false); // Controls visibility of the add topic form
  const [newTopicName, setNewTopicName] = useState(''); // Input state for new topic name
  const [newTopicColumns, setNewTopicColumns] = useState('Event Description'); // Input state for new topic columns
  const [showAddEvent, setShowAddEvent] = useState(false); // Controls visibility of the add event form
  const [newEventCustomTime, setNewEventCustomTime] = useState(''); // Input state for custom event time
  const [newEventData, setNewEventData] = useState({}); // Stores { headerName: value } for the new event form

  // State for configurable Spreadsheet ID
  const [userSpreadsheetId, setUserSpreadsheetId] = useState(''); // Holds the active Spreadsheet ID
  const [spreadsheetIdInput, setSpreadsheetIdInput] = useState(''); // Temp state for the Spreadsheet ID input field
  const [showIdInput, setShowIdInput] = useState(false); // Control visibility of Spreadsheet ID input UI

  // Refs for Google API clients
  const tokenClient = useRef(null); // Ref for the GIS Token Client
  const isSilentSigninAttempt = useRef(false); // Flag to track silent sign-in attempts

  // --- Effect: Initial check for essential config ---
  useEffect(() => {
    // Checks if the Google Client ID is loaded from environment variables
    if (!CLIENT_ID) {
      setError("Configuration Error: Ensure REACT_APP_GOOGLE_CLIENT_ID is set in your .env file and the server was restarted.");
      setIsLoading(false);
      setIsGapiReady(false); setIsGisReady(false); // Prevent further API initialization
    }
  }, []); // Run only once on mount


  // --- Sign Out Handler ---
  const handleSignOutClick = useCallback(() => {
    console.log("handleSignOutClick called");
    const token = window.gapi?.client?.getToken();
    if (token !== null) {
      // Revoke the current token
      void window.google?.accounts?.oauth2?.revoke(token.access_token, () => {
        console.log('Access token revoked');
        // Clear GAPI token and reset app state
        void window.gapi?.client?.setToken(null);
        setIsSignedIn(false); setCurrentUser(null); setTopics([]);
        setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]);
        setNewEventData({}); setError(null); setIsLoading(false);
      });
    } else {
        // If no token found, just reset state
        console.log("handleSignOutClick: No token found, resetting state.");
        setIsSignedIn(false); setCurrentUser(null); setTopics([]);
        setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]);
        setNewEventData({}); setError(null); setIsLoading(false);
    }
  }, []); // No dependencies needed for sign out logic itself


  // --- API Callbacks (Memoized) ---

  // Fetches the user's profile information (name, email) using People API
  const fetchUserProfile = useCallback(async () => {
      console.log("Attempting to fetch user profile...");
      // Ensure GAPI client is ready
      if (!window.gapi?.client) { console.warn("GAPI client not ready"); return Promise.reject("GAPI client not ready"); }

      // Load People API only if it hasn't been loaded yet
      if (!window.gapi?.client?.people) {
          try { await window.gapi?.client?.load('https://people.googleapis.com/$discovery/rest?version=v1'); }
          catch (loadErr) { console.error("Error loading People API:", loadErr); setError(`Could not load People API: ${loadErr.message}`); return Promise.reject(loadErr); }
      }
      // Double-check if People API is available after attempting to load
      if (!window.gapi?.client?.people) { console.error("People API client library not available"); setError("People API client library not available."); return Promise.reject("People API not available"); }

      try {
          // Request basic profile fields
          const response = await window.gapi.client.people.people.get({ resourceName: 'people/me', personFields: 'names,emailAddresses' });
          const profile = response.result;
          // Extract primary name and email, providing fallbacks
          const primaryName = profile.names?.find(n => n.metadata?.primary)?.displayName ?? (profile.names?.length > 0 ? profile.names[0].displayName : 'User');
          const primaryEmail = profile.emailAddresses?.find(e => e.metadata?.primary)?.value ?? (profile.emailAddresses?.length > 0 ? profile.emailAddresses[0].value : 'No email');
          setCurrentUser({ name: primaryName, email: primaryEmail });
          return Promise.resolve(); // Indicate success
      } catch (err) {
          console.error("Error fetching user profile:", err);
          const errorMsg = `Could not fetch profile: ${err.result?.error?.message || err.message}`;
          setError(errorMsg);
          // If auth error (401/403), trigger sign out
          if (err.status === 401 || err.status === 403) {
              console.warn("Auth error fetching profile, signing out.", err.status);
              setError(`Auth error fetching profile (${err.status}).`);
              handleSignOutClick();
          } else {
              console.warn("Non-auth error fetching profile.", err.status);
          }
          return Promise.reject(err); // Indicate failure
      }
  }, [handleSignOutClick]); // Depends on handleSignOutClick for error handling

  // Fetches the list of sheets (topics) from the specified spreadsheet
  const fetchTopics = useCallback(async (isInitialLoad = false, signedInStatus) => {
    console.log(`Attempting to fetch topics...`);
    // Skip if Spreadsheet ID is not set
    if (!userSpreadsheetId) { console.warn("Fetch topics skipped: Spreadsheet ID not set."); return Promise.resolve(); }
    // Skip if not signed in or Sheets API is not ready
    if (!signedInStatus || !window.gapi?.client?.sheets) { console.log(`Fetch topics skipped (Sign-in status or Sheets API not ready).`); return Promise.resolve(); }

    console.log("Fetching topics list...");
    // Show loading indicator only for manual refreshes
    if (!isInitialLoad) setIsFetchingTopics(true);
    setError(null); // Clear previous errors
    try {
      // Request sheet titles and IDs
      const response = await window.gapi.client.sheets.spreadsheets.get({
        spreadsheetId: userSpreadsheetId,
        fields: 'sheets(properties(title,sheetId))' // Only fetch necessary fields
      });
      const sheets = response.result.sheets || [];
      const topicData = sheets.map(sheet => ({ title: sheet.properties.title, sheetId: sheet.properties.sheetId }));
      setTopics(topicData);

      // Auto-select the first topic if none is selected or the current one disappeared
      const currentSelectedTopicExists = topicData.some(t => t.title === selectedTopic);
      if ((!currentSelectedTopicExists || !selectedTopic) && topicData.length > 0) {
        setSelectedTopic(topicData[0].title);
      } else if (topicData.length === 0) {
        // If no topics exist, clear selection
        setSelectedTopic('');
      }
      return Promise.resolve(); // Indicate success
    } catch (err) {
      console.error("Error fetching topics:", err);
      const errorMsg = `Error fetching topics: ${err.result?.error?.message || err.message}.`;
      setError(errorMsg);
      // Handle specific errors
       if (err.status === 401 || err.status === 403) { // Auth error
           console.warn("Auth error fetching topics, signing out.", err.status);
           setError("Auth error fetching topics.");
           handleSignOutClick();
       } else if (err.status === 404) { // Spreadsheet not found
           console.warn("Spreadsheet not found.", err.status);
           setError(`Spreadsheet not found or permission denied. Check ID.`);
       } else { // Other errors
           console.warn("Non-auth/404 error fetching topics.", err.status);
       }
       return Promise.reject(err); // Indicate failure
    } finally {
      // Hide loading indicator for manual refreshes
      if (!isInitialLoad) setIsFetchingTopics(false);
    }
  }, [handleSignOutClick, selectedTopic, userSpreadsheetId]); // Dependencies

  // --- Google API Initialization Callbacks (Memoized) ---

  // Initializes the Google API Client library (gapi)
  const initializeGapiClient = useCallback(async () => {
    console.log("Initializing GAPI client...");
    try {
      // Initialize the client library (API key not needed for OAuth flow)
      await window.gapi.client.init({});
      // Load the Google Sheets API discovery document
      await window.gapi.client.load('https://sheets.googleapis.com/$discovery/rest?version=v4');
      setIsGapiReady(true); // Set ready state
      console.log("GAPI client initialized successfully and Sheets API loaded.");
    } catch (err) {
      console.error("Error initializing GAPI client or loading Sheets API:", err);
      setError(`Error initializing Google API Client: ${err.message || JSON.stringify(err)}`);
      setIsGapiReady(false); // Set not ready state
      setIsLoading(false); // Stop main loading indicator
    }
  }, []); // No dependencies

  // Initializes the Google Identity Services (GIS) library for OAuth
  const initializeGisClient = useCallback(() => {
    // Ensure Client ID is available
    if (!CLIENT_ID) { console.error("Client ID missing, cannot initialize GIS."); return; }
    console.log("Initializing GIS client...");
    try {
        // Create a new token client for handling OAuth flow
        tokenClient.current = window.google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES, // Define required permissions
            callback: (tokenResponse) => { // Called on successful token acquisition
                console.log("GIS Token Callback received");
                const wasSilentAttempt = isSilentSigninAttempt.current;
                isSilentSigninAttempt.current = false; // Reset silent attempt flag

                if (tokenResponse.error) {
                    // Handle errors during token acquisition
                    console.error(`GIS Token Callback Error: ${tokenResponse.error}`);
                    // Don't show error for expected silent sign-in failures
                    const silentInteractionRequired = wasSilentAttempt && (tokenResponse.error === 'interaction_required' || tokenResponse.error === 'access_denied');
                    if (!silentInteractionRequired) {
                        setError(`Google Sign-In Error: ${tokenResponse.error || 'Unknown error'}`);
                    } else {
                        console.log("Silent sign-in requires user interaction.");
                    }
                    setIsSignedIn(false); setIsLoading(false); // Update state
                    return;
                }

                // If successful, store the token and update sign-in state
                if (tokenResponse && tokenResponse.access_token) {
                    console.log("GIS Token obtained successfully.");
                    window.gapi.client.setToken({ access_token: tokenResponse.access_token });
                    setIsSignedIn(true); console.log("Set isSignedIn = true.");
                    // Do not stop loading here; let the data fetching effects handle it
                } else {
                    // Handle unexpected missing token
                    console.error("GIS Token response missing access token:", tokenResponse);
                    setError("Failed to obtain access token from Google.");
                    setIsSignedIn(false); setIsLoading(false);
                }
            },
            error_callback: (error) => { // Called on non-token errors (e.g., popup blocked)
                console.warn("GIS Token Client error_callback triggered:", error);
                const wasSilentAttempt = isSilentSigninAttempt.current;
                isSilentSigninAttempt.current = false; // Reset silent attempt flag

                // Define error types often associated with silent failures
                const silentFailureTypes = ['popup_closed', 'immediate_failed', 'user_cancel', 'opt_out_or_no_session', 'suppressed_by_user'];
                const isKnownSilentFailure = error.type && silentFailureTypes.includes(error.type);
                // Treat as silent failure if it was a silent attempt AND the error type matches known silent failures or popup issues
                const treatAsSilent = wasSilentAttempt && (isKnownSilentFailure || error.type === 'popup_failed_to_open');

                if (treatAsSilent) {
                    console.log(`Silent sign-in failed via error_callback (Reason: ${error.type}).`);
                } else {
                    // Show error for non-silent failures
                    setError(`Google Sign-In Error: ${error.type || 'Unknown error'}`);
                }
                setIsSignedIn(false); setIsLoading(false); // Update state
            }
        });
        setIsGisReady(true); // Set GIS ready state
        console.log("GIS Token Client initialized successfully.");
    } catch (err) {
        // Handle errors during GIS client initialization
        console.error("Error initializing GIS Token Client:", err);
        setError(`Error initializing Google Sign-In: ${err.message || JSON.stringify(err)}`);
        setIsGisReady(false); // Set not ready state
        setIsLoading(false); // Stop main loading indicator
    }
  }, []); // No dependencies

  // --- Script Loading Callbacks ---

  // Loads the GAPI script dynamically
  const loadGapiScript = useCallback(() => {
    // Don't load if there's a config error
    if (error?.startsWith("Configuration Error")) return null;
    console.log("Loading GAPI script...");
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.async = true; script.defer = true;
    // Initialize GAPI client once the script is loaded
    script.onload = () => { console.log("GAPI script loaded."); if (window.gapi) { window.gapi.load('client', initializeGapiClient); } else { setError("GAPI script loaded but window.gapi not available."); } };
    script.onerror = () => setError("Failed to load Google API script.");
    document.body.appendChild(script);
    return script; // Return the script element for cleanup
  }, [initializeGapiClient, error]); // Depends on initializer and error state

  // Loads the GIS script dynamically
  const loadGisScript = useCallback(() => {
    // Don't load if there's a config error
    if (error?.startsWith("Configuration Error")) return null;
    console.log("Loading GIS script...");
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true; script.defer = true;
    // Initialize GIS client once the script is loaded
    script.onload = () => { console.log("GIS script loaded."); if (window.google?.accounts?.oauth2) { initializeGisClient(); } else { setError("GIS script loaded but google.accounts.oauth2 not available."); } };
    script.onerror = () => setError("Failed to load Google Identity Services script.");
    document.body.appendChild(script);
    return script; // Return the script element for cleanup
  }, [initializeGisClient, error]); // Depends on initializer and error state

  // --- Data Fetching Callbacks (continued) ---

  // Fetches events from the currently selected sheet (topic)
  const fetchEvents = useCallback(async () => {
    // Ensure Spreadsheet ID is set
    if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
    // Skip if no topic selected, not signed in, or Sheets API not ready
    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) { console.log("Fetch events skipped."); setEvents([]); return; }

    console.log(`Fetching events for topic: ${selectedTopic}`);
    setIsFetchingEvents(true); setError(null); // Show loading, clear errors
    try {
      // Define the range to fetch (assuming Timestamp in A, Description in B)
      // Adjust range if your structure differs or you want more columns
      const range = `${selectedTopic}!A2:B`; // Fetch from row 2 onwards
      const response = await window.gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: userSpreadsheetId,
        range: range,
      });
      const values = response.result.values || [];
      // Map sheet rows to event objects
      const loadedEvents = values.map((row, index) => ({
        id: `${selectedTopic}-${index}`, // Simple unique ID
        timestamp: row[0] || '', // Column A
        description: row[1] || '', // Column B (adjust if needed)
        rowNum: index + 2 // Store original row number (1-based index + 1 for header)
      })).sort((a, b) => { // Sort by timestamp descending (newest first)
        const dateA = new Date(a.timestamp);
        const dateB = new Date(b.timestamp);
        if (isNaN(dateA)) return 1; // Put invalid dates last
        if (isNaN(dateB)) return -1;
        return dateB - dateA; // Sort newest first
      });
      setEvents(loadedEvents);
    } catch (err) {
      console.error("Error fetching events:", err);
       const errorMessage = err.result?.error?.message || '';
       // Handle common "empty sheet" or "invalid range" errors gracefully
       if (err.status === 400 && (errorMessage.includes('Unable to parse range') || errorMessage.includes('exceeds grid limits'))) {
           console.log(`Sheet "${selectedTopic}" is likely empty/new or range is invalid.`);
           setEvents([]); // Set events to empty array
       } else {
           // Handle other errors (auth, etc.)
           const errorMsg = `Error fetching events: ${errorMessage}`;
           setError(errorMsg);
           if (err.status === 401 || err.status === 403) {
               console.warn("Auth error fetching events.", err.status);
               setError("Auth error fetching events.");
               handleSignOutClick();
           } else {
               console.warn("Non-auth/grid error fetching events.", err.status);
           }
       }
    } finally {
      console.log("fetchEvents finished.");
      setIsFetchingEvents(false); // Hide loading indicator
    }
  }, [selectedTopic, isSignedIn, handleSignOutClick, userSpreadsheetId]); // Dependencies

  // Fetches the header row (1:1) for the specified topic title
  const fetchTopicHeaders = useCallback(async (topicTitle) => {
      // Ensure Spreadsheet ID is set
      if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
      // Skip if no topic title, not signed in, or Sheets API not ready
      if (!topicTitle || !isSignedIn || !window.gapi?.client?.sheets) { console.log("Fetch headers skipped."); setCurrentTopicHeaders([]); return; }

      console.log(`Fetching headers for topic: ${topicTitle}`);
      setIsFetchingHeaders(true); setError(null); // Show loading, clear errors
      try {
          // Define range for the first row
          const range = `${topicTitle}!1:1`;
          const response = await window.gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: userSpreadsheetId,
            range: range
          });
          // Extract headers from the response, default to empty array
          const headers = response.result.values?.[0] || [];
          setCurrentTopicHeaders(headers);
      } catch (err) {
          console.error("Error fetching topic headers:", err);
          const errorMsg = `Error fetching headers: ${err.result?.error?.message || err.message}`;
          setError(errorMsg);
          setCurrentTopicHeaders([]); // Clear headers on error
          // Handle auth errors
          if (err.status === 401 || err.status === 403) {
              console.warn("Auth error fetching headers.", err.status);
              setError("Auth error fetching headers.");
              handleSignOutClick();
          } else {
              console.warn("Non-auth error fetching headers.", err.status);
          }
      } finally {
          console.log("fetchTopicHeaders finished.");
          setIsFetchingHeaders(false); // Hide loading indicator
      }
  }, [isSignedIn, handleSignOutClick, userSpreadsheetId]); // Dependencies


  // --- Action Handlers (Memoized) ---

  // Handles the explicit "Sign In" button click
  const handleAuthClick = useCallback(() => {
    // Don't proceed if there's a config error
    if (error?.startsWith("Configuration Error")) return;
    console.log("handleAuthClick called");
    setError(null); // Clear previous errors
    // Ensure GIS token client is ready
    if (!tokenClient.current) {
      setError("Google Sign-In is not ready yet.");
      setIsLoading(false); // Stop loading if GIS isn't ready
      return;
    }
    console.log("Requesting token access via GIS (with consent prompt)...");
    setIsLoading(true); // Show loading indicator during sign-in process
    isSilentSigninAttempt.current = false; // Mark as an explicit user-initiated attempt
    // Request access token, prompting user for consent if needed
    tokenClient.current.requestAccessToken({ prompt: 'consent' });
  }, [error]); // Depends on error state

  // Handles the submission of the "Add Topic" form
  const handleAddTopic = useCallback(async (e) => {
    e.preventDefault(); // Prevent default form submission
    // Ensure Spreadsheet ID is set
    if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
    console.log("handleAddTopic called");
    const trimmedTopicName = newTopicName.trim();
    const trimmedColumns = newTopicColumns.trim();

    // Basic validation
    if (!trimmedTopicName || !isSignedIn || !window.gapi?.client?.sheets) {
      setError("Topic name cannot be empty, or not signed in/ready.");
      return;
    }
    // Check for duplicate topic names
    if (topics.some(topic => topic.title === trimmedTopicName)) {
      setError(`Topic "${trimmedTopicName}" already exists.`);
      return;
    }

    // Prepare header columns: "Timestamp" + user-defined columns (or default)
    const userColumns = trimmedColumns ? trimmedColumns.split(',').map(col => col.trim()).filter(Boolean) : ['Event Description'];
    const finalHeaders = ["Timestamp", ...userColumns];
    const columnCount = finalHeaders.length;

    setIsLoading(true); setError(null); // Show loading, clear errors
    try {
      // 1. Add the new sheet
      const addSheetRequest = {
        requests: [
          { addSheet: { properties: { title: trimmedTopicName, gridProperties: { rowCount: 1, columnCount: columnCount } } } }
        ]
      };
      const response = await window.gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: userSpreadsheetId,
        resource: addSheetRequest
      });

      // Get the new sheet's ID from the response
      const newSheetProperties = response.result.replies?.[0]?.addSheet?.properties;
      const newSheetId = newSheetProperties?.sheetId;
      if (!newSheetId && newSheetId !== 0) { // Check if sheetId is valid (can be 0)
        throw new Error("Could not get sheetId for new sheet.");
      }

      // 2. Add the header row to the new sheet
      await window.gapi.client.sheets.spreadsheets.values.update({
        spreadsheetId: userSpreadsheetId,
        range: `${trimmedTopicName}!A1`, // Target cell A1 of the new sheet
        valueInputOption: 'USER_ENTERED',
        resource: { values: [finalHeaders] } // Headers as a 2D array
      });

      // 3. Update UI state
      setNewTopicName(''); setNewTopicColumns('Event Description'); // Reset form
      setShowAddTopic(false); // Hide form
      const newTopic = { title: trimmedTopicName, sheetId: newSheetId };
      setTopics(prevTopics => [...prevTopics, newTopic]); // Add to topics list
      setSelectedTopic(trimmedTopicName); // Select the newly added topic

    } catch (err) {
      console.error("Error adding topic:", err);
      const errorMsg = `Error adding topic: ${err.result?.error?.message || err.message}`;
      setError(errorMsg);
      // Handle auth errors
      if (err.status === 401 || err.status === 403) {
          console.warn("Auth error adding topic.", err.status);
          setError("Auth error adding topic.");
          handleSignOutClick();
      } else {
          console.warn("Non-auth error adding topic.", err.status);
      }
    } finally {
      setIsLoading(false); // Hide loading indicator
    }
  }, [newTopicName, newTopicColumns, isSignedIn, topics, handleSignOutClick, userSpreadsheetId]); // Dependencies

  // Handles the submission of the "Add Event" form
  const handleAddEvent = useCallback(async (e) => {
    e.preventDefault(); // Prevent default form submission
    // Ensure Spreadsheet ID is set
    if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
    console.log("handleAddEvent called");

    // Ensure headers are loaded before allowing event addition
    if (currentTopicHeaders.length === 0) {
      setError("Topic headers not loaded. Cannot determine event structure.");
      return;
    }

    // Basic validation: Check if at least one dynamic field is filled (unless only Timestamp column exists)
    const hasDynamicData = Object.values(newEventData).some(val => val && val.trim() !== '');
    const isTimestampOnly = currentTopicHeaders.length === 1; // Check if only 'Timestamp' header exists
    if (!isTimestampOnly && !hasDynamicData) {
        setError(`Please fill in at least one event detail.`);
        return;
    }

    // Ensure app is ready to add event
    if (!selectedTopic || !isSignedIn || !window.gapi?.client?.sheets) {
      setError("Cannot add event: Not signed in, no topic selected, or Google Sheets API not ready.");
      return;
    }

    setIsLoading(true); setError(null); // Show loading, clear errors
    try {
      // Determine timestamp: Use custom time if valid, otherwise use current time
      let timestamp = formatTimestamp(); // Default to now
      const trimmedTime = newEventCustomTime.trim();
      if (trimmedTime) {
          // Validate custom timestamp format (YYYY-MM-DD HH:MM:SS)
          if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmedTime)) {
              const parsedDate = new Date(trimmedTime);
              if (!isNaN(parsedDate.getTime())) { // Check if date is valid
                  timestamp = formatTimestamp(parsedDate); // Use valid custom time
              } else {
                  setError("Invalid custom date format (parsed as invalid date). Please use YYYY-MM-DD HH:MM:SS.");
                  setIsLoading(false); return; // Stop execution
              }
          } else {
              setError("Invalid custom date format. Please use YYYY-MM-DD HH:MM:SS.");
              setIsLoading(false); return; // Stop execution
          }
      }

      // Prepare row data based on current topic headers
      const rowData = currentTopicHeaders.map((header, index) => (
          index === 0 ? timestamp : (newEventData[header] || '') // Use timestamp for first col, form data otherwise
      ));

      // Prepare request body for appending the row
      const values = [rowData]; // Data must be a 2D array
      const body = { values: values };
      await window.gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: userSpreadsheetId,
        range: selectedTopic, // Append to the entire sheet (finds first empty row)
        valueInputOption: 'USER_ENTERED', // Interpret data as if typed by user
        insertDataOption: 'INSERT_ROWS', // Insert new rows for the data
        resource: body
      });

      // Reset form and refresh events list
      setNewEventCustomTime(''); setNewEventData({}); // Clear form inputs
      setShowAddEvent(false); // Hide form
      await fetchEvents(); // Refresh the event list to show the new event

    } catch (err) {
      console.error("Error adding event:", err);
      const errorMsg = `Error adding event: ${err.result?.error?.message || err.message}`;
      setError(errorMsg);
      // Handle auth errors
      if (err.status === 401 || err.status === 403) {
          console.warn("Auth error adding event.", err.status);
          setError("Auth error adding event.");
          handleSignOutClick();
      } else {
          console.warn("Non-auth error adding event.", err.status);
      }
    } finally {
      setIsLoading(false); // Hide loading indicator
    }
  }, [selectedTopic, isSignedIn, newEventCustomTime, fetchEvents, handleSignOutClick, currentTopicHeaders, newEventData, userSpreadsheetId]); // Dependencies

  // Handles the deletion of an event
  const handleDeleteEvent = useCallback(async (eventToDelete, sheetId) => {
      // Ensure Spreadsheet ID is set
      if (!userSpreadsheetId) { setError("Spreadsheet ID is not set."); return; }
      // Ensure required data is present
      if (!eventToDelete || sheetId === undefined || !isSignedIn || !window.gapi?.client?.sheets) {
          setError("Cannot delete event: missing required data or not signed in/ready.");
          return;
      }
      // Confirm deletion with the user
      if (!window.confirm(`Are you sure you want to delete the event: "${eventToDelete.description || eventToDelete.timestamp}"?`)) {
          return; // User cancelled
      }

      setIsLoading(true); setError(null); // Show loading, clear errors
      try {
          // Prepare batch update request to delete the specific row
          const deleteRequest = {
              requests: [
                  {
                      deleteDimension: {
                          range: {
                              sheetId: sheetId, // Target the correct sheet
                              dimension: "ROWS", // We are deleting a row
                              startIndex: eventToDelete.rowNum - 1, // API uses 0-based index
                              endIndex: eventToDelete.rowNum // End index is exclusive
                          }
                      }
                  }
              ]
          };
          // Execute the batch update
          await window.gapi.client.sheets.spreadsheets.batchUpdate({
              spreadsheetId: userSpreadsheetId,
              resource: deleteRequest
          });

          // Update UI state by removing the deleted event
          setEvents(prevEvents => prevEvents.filter(event => event.id !== eventToDelete.id));

      } catch (err) {
          console.error("Error deleting event:", err);
          const errorMsg = `Error deleting event: ${err.result?.error?.message || err.message}`;
          setError(errorMsg);
          // Handle auth errors
          if (err.status === 401 || err.status === 403) {
              console.warn("Auth error deleting event.", err.status);
              setError("Auth error deleting event.");
              handleSignOutClick();
          } else {
              console.warn("Non-auth error deleting event.", err.status);
          }
      } finally {
          setIsLoading(false); // Hide loading indicator
      }
  }, [isSignedIn, handleSignOutClick, userSpreadsheetId]); // Dependencies

  // Updates the state for dynamic event form fields
  const handleNewEventDataChange = (header, value) => {
      setNewEventData(prevData => ({ ...prevData, [header]: value }));
  };

  // Saves the entered Spreadsheet ID to localStorage and updates state
  const handleSaveSpreadsheetId = () => {
      const trimmedId = spreadsheetIdInput.trim();
      if (trimmedId) {
          localStorage.setItem(LOCAL_STORAGE_KEY, trimmedId); // Save to localStorage
          setUserSpreadsheetId(trimmedId); // Update active ID state
          setError(null); // Clear any previous ID errors
          setShowIdInput(false); // Hide the input UI

          // If signed in, reset topic/event data and fetch topics for the new ID
          if (isSignedIn) {
              setTopics([]); setSelectedTopic(''); setEvents([]); setCurrentTopicHeaders([]);
              fetchTopics(true, true); // Fetch topics for the newly saved ID
          }
      } else {
          setError("Please enter a valid Spreadsheet ID."); // Show error if input is empty
      }
  };

  // Shows the Spreadsheet ID input UI and clears related state
  const handleChangeSpreadsheetId = () => {
      setShowIdInput(true); // Show the input form
      // Clear data related to the previous ID
      setTopics([]); setSelectedTopic('');
      setEvents([]); setCurrentTopicHeaders([]);
      setError(null); // Clear errors
  };

  // --- Helper to get sheetId for the currently selected topic ---
  const getCurrentSheetId = () => topics.find(t => t.title === selectedTopic)?.sheetId;

  // --- Effects ---

  // Effect to check for configuration errors on mount
  useEffect(() => {
    if (!CLIENT_ID) {
      setError("Configuration Error: Ensure REACT_APP_GOOGLE_CLIENT_ID is set in your .env file and the server was restarted.");
      setIsLoading(false); setIsGapiReady(false); setIsGisReady(false);
    }
  }, []); // Runs once on mount

  // Effect to load saved Spreadsheet ID from localStorage on mount
  useEffect(() => {
      const savedId = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (savedId) {
          setUserSpreadsheetId(savedId); // Set active ID
          setSpreadsheetIdInput(savedId); // Pre-fill input field
          setShowIdInput(false); // Hide input initially if ID exists
      } else {
          // If no ID saved, show the input form and stop initial loading
          setShowIdInput(true);
          setIsLoading(false);
      }
  }, []); // Runs once on mount

  // Effect to load Google API scripts (GAPI & GIS)
  useEffect(() => {
    // Don't load scripts if there's a configuration error
    if (error?.startsWith("Configuration Error")) return;

    // Load scripts and store the returned script elements
    const gapiScript = loadGapiScript();
    const gisScript = loadGisScript();

    // Cleanup function to remove scripts when the component unmounts
    return () => {
      if (gapiScript?.parentNode) document.body.removeChild(gapiScript);
      if (gisScript?.parentNode) document.body.removeChild(gisScript);
    };
  }, [loadGapiScript, loadGisScript, error]); // Re-run if loaders or error state change

  // Effect to attempt silent sign-in once API scripts are ready
  useEffect(() => {
    // Conditions to attempt silent sign-in:
    // - No configuration error
    // - Both GAPI and GIS scripts are loaded and initialized
    // - User is not already signed in
    if (error?.startsWith("Configuration Error") || !isGapiReady || !isGisReady || isSignedIn) return;

    // Use a short timeout to ensure tokenClient is definitely initialized
    const timerId = setTimeout(() => {
        if (tokenClient.current) {
          console.log("Attempting silent sign-in...");
          isSilentSigninAttempt.current = true; // Mark as silent attempt
          setIsLoading(true); // Show loading during attempt
          // Request token without prompting the user
          tokenClient.current.requestAccessToken({ prompt: 'none' });
        } else {
          // This case should ideally not happen if isGisReady is true, but log just in case
          console.error("Token client not ready for silent sign-in despite GIS being ready.");
          setIsLoading(false); // Stop loading if client isn't ready
        }
    }, 100); // 100ms delay

    // Cleanup function to clear the timeout if dependencies change before it runs
    return () => clearTimeout(timerId);
  }, [isGapiReady, isGisReady, error, isSignedIn]); // Re-run if readiness, error, or sign-in state change

  // Effect to fetch initial user data (profile, topics) after successful sign-in
  useEffect(() => {
      // Conditions to fetch initial data:
      // - User is signed in
      // - GAPI client is ready
      // - A Spreadsheet ID is configured
      if (isSignedIn && isGapiReady && userSpreadsheetId) {
          setIsLoading(true); // Show loading indicator
          // Fetch profile and topics concurrently
          Promise.allSettled([fetchUserProfile(), fetchTopics(true, true)])
              .finally(() => {
                  // Stop loading indicator regardless of success/failure of fetches
                  setIsLoading(false);
              });
      } else if (!isSignedIn || !userSpreadsheetId) {
          // If not signed in or no Spreadsheet ID, ensure loading is stopped
          // unless there's a config error (which handles its own loading state)
          if (!error?.startsWith("Configuration Error")) {
              setIsLoading(false);
          }
      }
      // Intentionally excluding fetchUserProfile and fetchTopics from deps array
      // to prevent re-fetching on every render. They are stable due to useCallback.
      // We only want this effect to run when sign-in state, GAPI readiness, or Spreadsheet ID changes.
  }, [isSignedIn, isGapiReady, userSpreadsheetId, error, fetchUserProfile, fetchTopics]); // Dependencies

  // Effect to fetch events and headers when the selected topic changes
  useEffect(() => {
    // Conditions to fetch events/headers:
    // - A topic is selected
    // - User is signed in
    // - A Spreadsheet ID is configured
    if (selectedTopic && isSignedIn && userSpreadsheetId) {
        fetchEvents(); // Fetch events for the selected topic
        fetchTopicHeaders(selectedTopic); // Fetch headers for the selected topic
        setNewEventData({}); // Clear any lingering new event form data
    } else {
        // If conditions aren't met (e.g., no topic selected), clear event/header data
        setEvents([]);
        setCurrentTopicHeaders([]);
        setNewEventData({});
    }
    // Intentionally excluding fetchEvents and fetchTopicHeaders from deps array
    // as they are stable callbacks. This effect runs when the *selection* changes.
  }, [selectedTopic, isSignedIn, userSpreadsheetId, fetchEvents, fetchTopicHeaders]); // Dependencies


  // --- UI Rendering ---
  const showAppLoading = isLoading && !error; // Show main loader only if loading and no error

  // Render only error message if configuration is invalid
  if (error?.startsWith("Configuration Error")) {
     return (
       <div className="app-container">
         <div className="content-wrapper">
           <div className="error-box">{error}</div>
         </div>
       </div>
     );
  }

  // Main App Render
  return (
    <div className="app-container">
      <div className="content-wrapper">
        {/* Header Section */}
        <header className="header">
            {/* App Title and Logo - Wrapped for centering */}
            <h1>
                <span className="header-title-content"> {/* Wrapper Span */}
                    <img src={logo} alt="App logo" className="header-logo" />
                    Life Events Tracker
                </span>
            </h1>
            {/* User Info & Sign Out (only shown when signed in) */}
            <div className="auth-controls">
                {/* Loading indicator specific to auth/initial load */}
                {showAppLoading && <div className="loader">Loading...</div>}
                {/* User details and Sign Out button */}
                {isSignedIn && currentUser && (
                    <div className="user-info">
                        <span className="user-details" title={currentUser.email}>{currentUser.email.toLowerCase()}</span>
                        <button onClick={handleSignOutClick} className="button button-danger">Sign Out</button>
                    </div>
                )}
            </div>
        </header>

        {/* Sign-in Button Area (Moved below header) */}
        <div className="signin-container">
            {/* Show Sign-In button only if APIs ready, not signed in, and not loading */}
            {isGapiReady && isGisReady && !isSignedIn && !showAppLoading && (
                <button onClick={handleAuthClick} disabled={showAppLoading} className="button button-primary"> {/* Changed back to button-primary */}
                    {/* Inline SVG Google Logo */}
                    <svg className="google-logo-svg" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" >
                        <path fill="#4285F4" d="M17.64 9.20455c0-.63864-.05727-1.25182-.16818-1.84091H9v3.48182h4.84364c-.20864 1.125-.84091 2.07818-1.77727 2.71636v2.25818h2.90864c1.70182-1.56636 2.68364-3.87409 2.68364-6.61545z"/>
                        <path fill="#34A853" d="M9 18c2.43 0 4.46727-.80591 5.95636-2.18045l-2.90864-2.25818c-.80591.54-1.83727.86182-2.98955.86182-2.28773 0-4.22182-1.54636-4.91182-3.61636H1.07182v2.33045C2.55364 16.31045 5.52182 18 9 18z"/>
                        <path fill="#FBBC05" d="M4.08818 10.8164c-.11818-.35636-.18409-.73455-.18409-1.125 0-.39091.06591-.76818.18409-1.125V6.23591H1.07182C.63409 7.17409.38636 8.26182.38636 9.375s.24773 2.20091.68546 3.14091l3.01636-2.33045z"/>
                        <path fill="#EA4335" d="M9 3.575c1.32182 0 2.50773.45591 3.44 1.34864l2.58182-2.58182C13.4636.891818 11.4259 0 9 0 5.52182 0 2.55364 1.68955 1.07182 4.18909l3.01636 2.33045C4.77818 4.54591 6.71227 3.575 9 3.575z"/>
                    </svg>
                    {/* Button Text */}
                    Sign In with Google
                </button>
            )}
        </div>

        {/* Error Display Area */}
        {error && !error.startsWith("Configuration Error") && (
          <div className="error-box">
            <strong>Error: </strong>
            <span>{error}</span>
            {/* Button to dismiss error */}
            <button onClick={() => setError(null)} className="close-button" aria-label="Close error message">&times;</button>
          </div>
        )}

        {/* Spreadsheet ID Input Section (only shown when signed in) */}
        {isSignedIn && (
          <section className="section spreadsheet-id-section">
            {/* Display current ID and Change button OR show input form */}
            {!showIdInput && userSpreadsheetId ? (
              <div className="spreadsheet-id-display">
                <span>Using Spreadsheet (ID): <code>{userSpreadsheetId}</code></span>
                <button onClick={handleChangeSpreadsheetId} className="button button-change-id button-small">Change</button>
              </div>
            ) : (
              <div className="form spreadsheet-id-form">
                <label htmlFor="spreadsheet-id-input">Enter Google Spreadsheet ID:</label>
                <div className="form-row">
                  <input
                    id="spreadsheet-id-input"
                    type="text"
                    value={spreadsheetIdInput}
                    onChange={(e) => setSpreadsheetIdInput(e.target.value)}
                    placeholder="Paste Spreadsheet ID here"
                    className="input-field"
                    disabled={isLoading} // Disable input while loading
                  />
                  <button onClick={handleSaveSpreadsheetId} disabled={isLoading} className="button button-primary">Save ID</button>
                  {/* Show Cancel button only if an ID was previously set */}
                  {userSpreadsheetId && (
                    <button
                      type="button"
                      onClick={() => { setShowIdInput(false); setSpreadsheetIdInput(userSpreadsheetId); setError(null); }}
                      className="button button-secondary"
                    >
                      Cancel
                    </button>
                  )}
                </div>
                <p className="help-text">Find the ID in your spreadsheet's URL: .../spreadsheets/d/<b>SPREADSHEET_ID</b>/edit</p>
              </div>
            )}
          </section>
        )}

        {/* Initializing Message */}
        {(!isGapiReady || !isGisReady) && !error && !showAppLoading && (
          <p className="status-message">Initializing Google Services...</p>
        )}

        {/* Main Content Area (Topics & Events) - Requires Sign In and Spreadsheet ID */}
        {isSignedIn && userSpreadsheetId && !showAppLoading && (
          <main>
            {/* Topic Management Section */}
            <section className="section">
              <div className="section-header">
                <h2>Topics</h2>
                <div className="controls">
                  {/* Refresh Topics Button */}
                  <button onClick={() => fetchTopics(false, isSignedIn)} disabled={isFetchingTopics || isLoading} title="Refresh Topics" className="button button-icon">
                    <span role="img" aria-label="Refresh Topics">↻</span>
                  </button>
                  {/* Add Topic Button */}
                  <button onClick={() => setShowAddTopic(!showAddTopic)} className="button button-secondary" disabled={isLoading}>
                    {showAddTopic ? '- Cancel Add' : '+ Add Topic'}
                  </button>
                </div>
              </div>

              {/* Add Topic Form (Conditional) */}
              {showAddTopic && (
                <form onSubmit={handleAddTopic} className="form add-topic-form">
                  <div className="form-group">
                    <label htmlFor="new-topic">New Topic Name:</label>
                    <input
                      id="new-topic" type="text" value={newTopicName}
                      onChange={(e) => setNewTopicName(e.target.value)}
                      placeholder="e.g., Work Meetings" required className="input-field"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="new-topic-columns">Column Headers (after Timestamp, comma-separated):</label>
                    <input
                      id="new-topic-columns" type="text" value={newTopicColumns}
                      onChange={(e) => setNewTopicColumns(e.target.value)}
                      placeholder="e.g., Description, Category, Duration" className="input-field"
                    />
                    <p className="help-text">Defaults to "Event Description". Timestamp column is always added first.</p>
                  </div>
                  <div className="form-actions">
                    <button type="submit" disabled={isLoading} className="button button-primary">Create</button>
                    <button type="button" onClick={() => setShowAddTopic(false)} className="button button-secondary">Cancel</button>
                  </div>
                </form>
              )}

              {/* Topic Loading/Selection */}
              {isFetchingTopics && <p className="status-message">Loading topics...</p>}
              {!isFetchingTopics && topics.length > 0 ? (
                <select value={selectedTopic} onChange={(e) => setSelectedTopic(e.target.value)} disabled={isLoading} className="select-field">
                  {/* Default disabled option */}
                  <option value="" disabled={selectedTopic !== ''}>-- Select a Topic --</option>
                  {/* Populate options from fetched topics */}
                  {topics.map(topic => (
                    <option key={topic.sheetId} value={topic.title}>{topic.title}</option>
                  ))}
                </select>
              ) : (
                // Message when no topics are found (and not loading)
                !isFetchingTopics && isSignedIn && <p className="status-message">No topics found. Add one to get started!</p>
              )}
            </section>

            {/* Events Section (Conditional on Topic Selection) */}
            {selectedTopic && (
              <section className="section">
                <div className="section-header">
                  <h2>Events for "{selectedTopic}"</h2>
                  {/* Add Event Button */}
                  <button onClick={() => setShowAddEvent(!showAddEvent)} className="button button-secondary" disabled={isLoading || isFetchingHeaders}>
                    {showAddEvent ? '- Cancel Add' : '+ Add Event'}
                  </button>
                </div>

                {/* Add Event Form (Conditional) */}
                {showAddEvent && (
                  <form onSubmit={handleAddEvent} className="form add-event-form">
                    {/* Custom Timestamp Input */}
                    <div className="form-group">
                      <label htmlFor="new-event-time">Custom Timestamp (Optional):</label>
                      <input
                        id="new-event-time" type="text" value={newEventCustomTime}
                        onChange={(e) => setNewEventCustomTime(e.target.value)}
                        placeholder={`Format: YYYY-MM-DD HH:MM:SS (e.g., ${formatTimestamp()})`}
                        className="input-field"
                      />
                      <p className="help-text">Leave blank to use the current time.</p>
                    </div>
                    {/* Dynamic Inputs based on Topic Headers */}
                    {currentTopicHeaders.slice(1).map((header, index) => ( // Skip 'Timestamp' header (index 0)
                      <div className="form-group" key={`event-col-${index}`}>
                        <label htmlFor={`event-input-${header}`}>{header}:</label>
                        <input
                          id={`event-input-${header}`}
                          type="text"
                          value={newEventData[header] || ''} // Controlled input
                          onChange={(e) => handleNewEventDataChange(header, e.target.value)}
                          className="input-field"
                        />
                      </div>
                    ))}
                    {/* Form Actions */}
                    <div className="form-actions">
                      <button type="submit" disabled={isLoading} className="button button-primary">Add Event</button>
                      <button
                        type="button"
                        onClick={() => { setShowAddEvent(false); setNewEventData({}); setNewEventCustomTime(''); }} // Reset form on cancel
                        className="button button-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}

                {/* Event List Loading/Display */}
                {isFetchingEvents && <p className="status-message">Loading events...</p>}
                {!isFetchingEvents && events.length > 0 ? (
                  <ul className="event-list">
                    {events.map(event => (
                      <li key={event.id} className="event-item">
                        {/* Event Details */}
                        <div className="event-content">
                          {/* Display description or timestamp if description is empty */}
                          <p className="event-description">{event.description || '(No description)'}</p>
                          <p className="event-timestamp">{event.timestamp}</p>
                        </div>
                        {/* Delete Event Button */}
                        <button
                          onClick={() => handleDeleteEvent(event, getCurrentSheetId())}
                          disabled={isLoading}
                          className="button button-delete"
                          title="Delete Event"
                          aria-label={`Delete event from ${event.timestamp}`}
                        >
                          &times;
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  // Message when no events found (and not loading)
                  !isFetchingEvents && isSignedIn && selectedTopic && <p className="status-message">No events found for this topic yet.</p>
                )}
              </section>
            )}
          </main>
        )}

        {/* Prompts based on application state */}
        {/* Prompt to configure Spreadsheet ID */}
        {isSignedIn && !userSpreadsheetId && !showIdInput && !isLoading && (
          <p className="status-message">Please configure a Spreadsheet ID to load data.</p>
        )}
        {/* Prompt to Sign In */}
        {!isSignedIn && isGapiReady && isGisReady && !showAppLoading && (
          <p className="status-message">Please sign in to manage your event logs.</p>
        )}
      </div>
    </div>
  );
}

export default App;

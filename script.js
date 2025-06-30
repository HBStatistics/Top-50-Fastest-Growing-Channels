const API_KEY = 'AIzaSyBgELAGkvluwfu6CNKHNDTwq20_8lckcZU'; // IMPORTANT: Replace with a valid YouTube Data API key from Google Cloud Console.

const container = document.getElementById('channelList');
const odometerInstances = new Map();
const LOCAL_STORAGE_KEY = 'channelDashboardState';
const SORT_MODE_KEY = 'dashboardSortMode';
const DAILY_STATS_KEY = 'channelDashboardDailyStats';
let channels = [];
let currentChannelIds = [];
let subCountUpdateInterval = null;
let totalCountOdometer = null;
let currentTopChannelImageUrl = null;
let currentSortMode = 'daily'; // 'daily' or 'live'
const colorThief = new ColorThief();

/**
 * Fetches both snippet (name, image) and statistics (subscriber count) for a list of channel IDs.
 * @param {string[]} idArray An array of YouTube channel IDs.
 * @returns {Promise<object[]>} A promise that resolves to an array of channel data objects.
 */
async function fetchChannelsData(idArray) {
  const idString = idArray.join(',');
  // Fetch only static data (snippet) from YouTube to preserve API quota.
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${idString}&key=${API_KEY}`);
  const data = await res.json();

  if (!data.items || data.items.length === 0) {
    console.error(`Could not fetch channel data. Response:`, data);
    return [];
  }

  // Map the API response to our desired channel object structure.
  return data.items.map(item => {
    let handle = item.snippet.customUrl || item.snippet.title;
    if (handle && !handle.startsWith('@')) {
      handle = '@' + handle;
    }
    return {
      id: item.id,
      name: item.snippet.title, // Keep original name for alt tags, etc.
      handle: handle,
      img: item.snippet.thumbnails.medium.url, // Use medium res for better color sampling
      country: item.snippet.country,
    };
  });
}

/**
 * Fetches the live, unabbreviated subscriber count from the Mixerno API.
 * @param {string} channelId A YouTube channel ID.
 * @returns {Promise<number>} A promise that resolves to the subscriber count.
 */
async function fetchSubCount(channelId) {
  try {
    const res = await fetch(`https://mixerno.space/api/youtube-channel-counter/user/${channelId}`);
    if (!res.ok) {
      console.error(`Failed to fetch sub count for ${channelId}. Status: ${res.status}`);
      return 0;
    }
    const data = await res.json();
    // This API endpoint returns the count inside a `counts` array.
    if (data.counts && data.counts.length > 0) {
        return data.counts[0].count || 0;
    }
    console.warn(`Could not find sub count for ${channelId} in API response:`, data);
    return 0;
  } catch (error) {
    console.error(`Error fetching sub count for ${channelId}:`, error);
    return 0;
  }
}

/**
 * Sets the page background to a radial gradient based on the top channel's logo color.
 * This uses the weserv.nl image service to extract the dominant color palette,
 * which avoids client-side CORS issues entirely.
 * @param {string} imageUrl The URL of the channel's logo.
 */
function updatePageBackground(imageUrl) {
  const img = new Image();
  img.crossOrigin = 'Anonymous';
  // Using a CORS proxy to prevent security errors when accessing image data.
  // The previous service (images.weserv.nl) is returning a 404 error.
  const proxiedUrl = `https://api.codetabs.com/v1/proxy?quest=${imageUrl}`;
  img.src = proxiedUrl;

  img.addEventListener('load', () => {
    try {
      const [r, g, b] = colorThief.getColor(img);

      // Darken the color for a subtle background effect
      const darkenFactor = 0.4;
      const darkR = Math.floor(r * darkenFactor);
      const darkG = Math.floor(g * darkenFactor);
      const darkB = Math.floor(b * darkenFactor);

      // Get the base background color from the current theme's CSS variable
      const baseBgColor = getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim();

      // Apply a "fancy" radial gradient as the new background
      document.body.style.background = `radial-gradient(circle at 50% 0%, rgba(${darkR}, ${darkG}, ${darkB}, 0.5) 0%, ${baseBgColor} 80%)`;
      document.body.style.backgroundAttachment = 'fixed'; // Keep gradient fixed on scroll
    } catch (e) {
      console.error(`Could not get color for page background: ${imageUrl}`, e);
    }
  });

  img.addEventListener('error', () => {
    console.error(`Failed to load image for background color extraction: ${proxiedUrl}`);
  });
}

/**
 * Formats the daily gain number into a styled string.
 * @param {number} gain The daily subscriber gain.
 * @returns {string} The formatted HTML string.
 */
function formatDailyGain(gain) {
  // Don't show if there's no historical data or no change
  if (gain === 0 || gain === undefined || gain === null) return '';
  const sign = gain > 0 ? '+' : '';
  const number = gain.toLocaleString(); // Adds commas
  const colorClass = gain > 0 ? 'gain-positive' : 'gain-negative';
  return `<span class="daily-gain ${colorClass}" title="Subscribers gained in the last ~24 hours">(${sign}${number})</span>`;
}

/**
 * Draws a mini-graph of recent subscriber gains for a channel.
 * @param {object} channel The channel object, containing gainHistory.
 */
function drawSparkline(channel) {
  const canvas = document.getElementById(`graph-${channel.id}`);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const history = channel.gainHistory;
  const width = canvas.width;
  const height = canvas.height;
  const stepX = width / (history.length - 1);
  // Use at least 1 to avoid division by zero and give a baseline
  const maxGain = Math.max(...history, 1);

  ctx.clearRect(0, 0, width, height);
  ctx.beginPath();
  ctx.lineWidth = 1.5;
  // Use a theme-aware color for the graph line
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim();

  history.forEach((gain, index) => {
    const x = index * stepX;
    // Invert Y-axis because canvas (0,0) is top-left. Add a small bottom padding.
    const y = height - (gain / maxGain) * (height - 2) - 1;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  ctx.stroke();
}

async function createChannels(channelIds) {
  // Display a loader while fetching initial data
  container.innerHTML = '<div class="loader"></div>';

  const savedStateJSON = localStorage.getItem(LOCAL_STORAGE_KEY);

  // Try to load state from localStorage if it exists and matches the current channel list
  if (savedStateJSON) {
    const savedState = JSON.parse(savedStateJSON);
    if (JSON.stringify(savedState.ids) === JSON.stringify(channelIds)) {
      console.log("Loading channel data from saved state.");
      channels = savedState.channels;
    }
  }

  // If no valid saved state, fetch fresh data from the API
  if (channels.length === 0) {
    console.log("No valid saved state. Fetching fresh data from API.");
    // 1. Fetch static data (name, image, etc.)
    channels = await fetchChannelsData(channelIds);
    if (channels.length === 0) {
        container.innerHTML = '<p style="text-align: center;">Failed to load channel data. Please check your API key and the console for errors.</p>';
        return;
    }
    // 2. Fetch initial subscriber counts from Mixerno
    const initialSubCounts = await Promise.all(
      channels.map(channel => fetchSubCount(channel.id))
    );
    // 3. Combine the data
    channels.forEach((channel, index) => {
      channel.subs = initialSubCounts[index] || 0;
      channel.gain = 0;
      channel.isOnFire = false; // Initialize property
      channel.dailyGain = 0; // Initialize property
      channel.gainHistory = new Array(30).fill(0); // History for 1 minute (30 * 2s)
    });
  }

  // --- Daily Gain Calculation ---
  // 1. Load historical data for daily gain calculation
  const dailyHistory = JSON.parse(localStorage.getItem(DAILY_STATS_KEY));
  const twentyFourHours = 24 * 60 * 60 * 1000;

  // 2. Calculate daily gain for each channel
  channels.forEach(channel => {
    if (dailyHistory && dailyHistory.counts && dailyHistory.counts[channel.id]) {
      channel.dailyGain = channel.subs - dailyHistory.counts[channel.id];
    }
  });

  // 3. Check if it's time to save a new snapshot for the next day's calculation
  if (!dailyHistory || (Date.now() - dailyHistory.timestamp > twentyFourHours)) {
    console.log("Saving new daily stats snapshot for the next 24-hour period.");
    const newDailyHistory = {
      timestamp: Date.now(),
      counts: channels.reduce((acc, { id, subs }) => ({ ...acc, [id]: subs }), {})
    };
    localStorage.setItem(DAILY_STATS_KEY, JSON.stringify(newDailyHistory));
  }

  // Sort channels by growth rate to maintain consistent ranking on refresh
  if (currentSortMode === 'daily') {
    channels.sort((a, b) => b.dailyGain - a.dailyGain);
  } else {
    channels.sort((a, b) => b.gain - a.gain);
  }

  // Set initial page background based on top channel
  if (channels.length > 0) {
    currentTopChannelImageUrl = channels[0].img;
    updatePageBackground(currentTopChannelImageUrl);
  }

  // Clear the loader
  container.innerHTML = '';

  channels.forEach((channel, index) => {
    const div = document.createElement('div');
    div.className = 'channel';
    div.id = `channel-${channel.id}`;
    const rank = (index + 1).toString().padStart(2, '0');
    const flagHtml = channel.country
      ? `<img class="channel-flag" src="https://flagcdn.com/w20/${channel.country.toLowerCase()}.png" alt="${channel.country} flag" title="${channel.country}">`
      : '';
    const dailyGainHtml = formatDailyGain(channel.dailyGain);

    div.innerHTML = `
      <div class="rank-container">
        <div class="channel-rank">${rank}</div>
        <div class="fire-icon" style="display: none;">🔥</div>
      </div>
      <div class="channel-avatar-container">
        <img class="channel-avatar" src="${channel.img}" alt="${channel.name}">
        ${flagHtml}
      </div>
      <div class="channel-details">
        <div class="channel-name-container">
          <div class="channel-name">${channel.handle}</div>
          <div id="daily-gain-container-${channel.id}" class="daily-gain-container">${dailyGainHtml}</div>
        </div>
        <div class="sub-counter-container">
          <div id="subs-${channel.id}" class="odometer odometer-theme-default"></div>
          <canvas id="graph-${channel.id}" class="sparkline-graph" width="120" height="25" title="Subscriber gain over last minute"></canvas>
        </div>
      </div>
    `;
    container.appendChild(div);

    // Manually initialize Odometer on the newly created element.
    // Store the instance so we can call its .update() method later.
    const odInstance = new Odometer({
      el: document.getElementById(`subs-${channel.id}`),
      value: channel.subs,
      duration: 2000, // Set animation speed to 2 seconds
    });
    odometerInstances.set(channel.id, odInstance);

    // Draw the initial empty graph
    drawSparkline(channel);
  });

  // The odometers are already initialized with the correct counts.
  // Clear any existing interval before setting a new one.
  if (subCountUpdateInterval) {
    clearInterval(subCountUpdateInterval);
  }
  // Use a faster interval now that we are using the Mixerno API for frequent updates.
  subCountUpdateInterval = setInterval(updateCounts, 2000); // Update every 2 seconds
}

async function updateCounts() {
  // Store the ID of the top channel *before* fetching new data and re-sorting
  const topChannelIdBeforeUpdate = channels.length > 0 ? channels[0].id : null;

  // Store the current order of channel IDs before re-sorting
  const oldOrderIds = channels.map(c => c.id);

  // Load daily history to recalculate daily gains as counts update
  const dailyHistory = JSON.parse(localStorage.getItem(DAILY_STATS_KEY));

  // 1. Fetch fresh subscriber counts from Mixerno in parallel
  const allNewSubs = await Promise.all(
    channels.map(channel => fetchSubCount(channel.id))
  );

  // 2. Update channel data and DOM with new counts
  channels.forEach((channel, index) => {
    const newSubs = allNewSubs[index];
    if (newSubs > 0) { // Only update if the fetch was successful
      const oldSubs = channel.subs;

      if (oldSubs > 0) {
        channel.gain = newSubs - oldSubs;
      }
      // A channel is "on fire" if gaining over 5,000 subs/hour.
      // (gain per 2s) * 1800 (intervals in an hour) > 5000
      // Simplified: gain per 2s > 2.77
      channel.isOnFire = channel.gain >= 3;
      channel.subs = newSubs;

      // Recalculate daily gain and update the UI
      if (dailyHistory && dailyHistory.counts && dailyHistory.counts[channel.id]) {
        channel.dailyGain = channel.subs - dailyHistory.counts[channel.id];
        const dailyGainContainer = document.getElementById(`daily-gain-container-${channel.id}`);
        if (dailyGainContainer) {
          // formatDailyGain returns the full HTML span or an empty string
          dailyGainContainer.innerHTML = formatDailyGain(channel.dailyGain);
        }
      }

      // Update gain history for the sparkline graph.
      // Don't graph negative gains as they are usually data corrections.
      channel.gainHistory.shift();
      channel.gainHistory.push(channel.gain < 0 ? 0 : channel.gain);
      drawSparkline(channel);

      const odInstance = odometerInstances.get(channel.id);
      if (odInstance) {
        odInstance.update(newSubs);
      }
    }
  });

  // 3. Sort channels by the calculated daily gain
  if (currentSortMode === 'daily') {
    channels.sort((a, b) => b.dailyGain - a.dailyGain);
  } else {
    channels.sort((a, b) => b.gain - a.gain);
  }
  
  // Get the ID of the new top channel
  const topChannelIdAfterUpdate = channels.length > 0 ? channels[0].id : null;

  // Update page background ONLY if the top channel has changed
  if (topChannelIdAfterUpdate && topChannelIdAfterUpdate !== topChannelIdBeforeUpdate) {
    currentTopChannelImageUrl = channels[0].img;
    updatePageBackground(currentTopChannelImageUrl);
  }

  updateDomOrderAndVisuals(oldOrderIds);
  // 5. Find and highlight the fastest gainer (most subs in last interval)
  let fastestGainer = null;
  let maxGain = 0;
  channels.forEach(channel => {
    if (channel.gain > maxGain) {
      maxGain = channel.gain;
      fastestGainer = channel;
    }
  });

  // 6. Update the visual indicator for the fastest gainer
  channels.forEach(channel => {
    const element = document.getElementById(`channel-${channel.id}`);
    element.classList.toggle('fastest-gainer', channel === fastestGainer);
  });

  // 7. Save the updated state to localStorage to persist across refreshes
  const stateToSave = {
    ids: channels.map(c => c.id),
    channels: channels
  };
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateToSave));
}

/**
 * Re-orders DOM elements based on the `channels` array, updates ranks, and applies animations.
 * @param {string[]} oldOrderIds An array of channel IDs in their previous order.
 */
function updateDomOrderAndVisuals(oldOrderIds) {
  channels.forEach((channel, newIndex) => {
    const element = document.getElementById(`channel-${channel.id}`);
    if (!element) return;

    const oldIndex = oldOrderIds.findIndex(id => id === channel.id);

    element.querySelector('.channel-rank').textContent = (newIndex + 1).toString().padStart(2, '0');

    // Update fire icon visibility
    const fireIcon = element.querySelector('.fire-icon');
    if (fireIcon) {
      fireIcon.style.display = channel.isOnFire ? 'block' : 'none';
    }

    // Animate if the channel moved up in the ranking
    if (oldIndex !== -1 && newIndex < oldIndex) {
      element.classList.add('rank-up-animation');
      element.addEventListener('animationend', () => element.classList.remove('rank-up-animation'), { once: true });
    }

    container.appendChild(element); // This re-orders the element in the DOM
  });
}

/**
 * Initializes the search bar functionality to filter channels.
 */
function initializeSearchBar() {
  const searchBar = document.getElementById('search-bar');
  const clearBtn = document.getElementById('clear-search-btn');
  if (!searchBar || !clearBtn) return;

  searchBar.addEventListener('input', (event) => {
    const query = event.target.value.toLowerCase().trim();
    clearBtn.style.display = query ? 'block' : 'none'; // Show button if there's text
    const channelElements = document.querySelectorAll('.channel');

    channelElements.forEach(element => {
      const channelNameElement = element.querySelector('.channel-name');
      if (channelNameElement) {
        const channelName = channelNameElement.textContent.toLowerCase();
        // Show the element if its name includes the query, hide otherwise.
        element.style.display = channelName.includes(query) ? 'flex' : 'none';
      }
    });
  });

  clearBtn.addEventListener('click', () => {
    searchBar.value = '';
    // Programmatically trigger the 'input' event to reset the filter
    const inputEvent = new Event('input', { bubbles: true });
    searchBar.dispatchEvent(inputEvent);
    searchBar.focus(); // Keep focus on the search bar
  });
}

/**
 * Initializes the theme toggle button and loads the saved theme preference.
 */
function initializeThemeToggle() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (!themeToggleBtn) return;

  const THEME_KEY = 'dashboardTheme';
  const lightModeClass = 'light-mode';
  const sunIcon = '☀️';
  const moonIcon = '🌙';

  // Function to apply the theme based on the string 'light' or 'dark'
  const applyTheme = (theme) => {
    if (theme === 'light') {
      document.body.classList.add(lightModeClass);
      themeToggleBtn.textContent = moonIcon;
      themeToggleBtn.title = 'Switch to dark mode';
    } else {
      document.body.classList.remove(lightModeClass);
      themeToggleBtn.textContent = sunIcon;
      themeToggleBtn.title = 'Switch to light mode';
    }
    // Re-apply the background with the new theme's base color
    if (currentTopChannelImageUrl) {
      // Use a timeout to ensure CSS variables have been updated by the browser
      setTimeout(() => updatePageBackground(currentTopChannelImageUrl), 50);
    }
  };

  // Check for a saved theme preference in localStorage and apply it
  const savedTheme = localStorage.getItem(THEME_KEY);
  if (savedTheme) {
    applyTheme(savedTheme);
  }

  // Add the click event listener to toggle the theme
  themeToggleBtn.addEventListener('click', () => {
    const isCurrentlyLight = document.body.classList.contains(lightModeClass);
    const newTheme = isCurrentlyLight ? 'dark' : 'light';
    applyTheme(newTheme);
    localStorage.setItem(THEME_KEY, newTheme);
  });
}

/**
 * Initializes the settings panel for choosing the sort method.
 */
function initializeSettingsPanel() {
  const controlsContainer = document.querySelector('.header-controls');
  if (!controlsContainer) return;

  // 1. Inject the HTML for the button and panel
  const settingsBtn = document.createElement('button');
  settingsBtn.id = 'settings-btn';
  settingsBtn.className = 'header-btn';
  settingsBtn.title = 'Settings';
  settingsBtn.innerHTML = '⚙️';
  controlsContainer.appendChild(settingsBtn);

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.className = 'settings-panel';
  panel.style.display = 'none'; // Initially hidden
  panel.innerHTML = `
    <h4>Sort By</h4>
    <div class="setting-option">
      <input type="radio" id="sort-daily" name="sort-mode" value="daily">
      <label for="sort-daily">Daily Gain</label>
    </div>
    <div class="setting-option">
      <input type="radio" id="sort-live" name="sort-mode" value="live">
      <label for="sort-live">Live Gain (2s)</label>
    </div>
  `;
  controlsContainer.appendChild(panel);

  // 2. Load saved preference
  const savedSortMode = localStorage.getItem(SORT_MODE_KEY);
  if (savedSortMode) {
    currentSortMode = savedSortMode;
  }
  panel.querySelector(`input[value="${currentSortMode}"]`).checked = true;

  // 3. Add event listeners
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent the document click listener from firing immediately
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  // Hide panel if clicking outside of it
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== settingsBtn) {
      panel.style.display = 'none';
    }
  });

  panel.querySelectorAll('input[name="sort-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const oldOrderIds = channels.map(c => c.id);
      currentSortMode = radio.value;
      localStorage.setItem(SORT_MODE_KEY, currentSortMode);

      // Sort the global channels array based on the new mode
      if (currentSortMode === 'daily') {
        channels.sort((a, b) => b.dailyGain - a.dailyGain);
      } else { // 'live'
        channels.sort((a, b) => b.gain - a.gain);
      }
      // Immediately update the DOM to reflect the new sort order
      updateDomOrderAndVisuals(oldOrderIds);
    });
  });
}

/**
 * Injects custom CSS to adjust font sizes for better readability.
 */
function applyCustomStyles() {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --gain-color: #4caf50;
      --loss-color: #f44336;
    }
    body.light-mode {
      --gain-color: #2e7d32;
      --loss-color: #c62828;
    }
    .channel {
      /* Increase vertical padding to make the boxes taller */
      padding-top: 12px;
      padding-bottom: 12px;
    }
    .channel-name {
      font-size: 1.2rem; /* Increased from 1.1rem */
      font-weight: 500;
    }
    .odometer {
      font-size: 1.6rem; /* Increased from 1.4rem */
      font-weight: 600;
      position: relative; /* Ensure odometer is on top */
      z-index: 2;
    }
    .channel-name-container {
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .daily-gain-container {
      /* This container just holds the span, so it shouldn't affect layout itself */
      line-height: 1;
    }
    .daily-gain {
      font-size: 0.8rem;
      font-weight: 500;
      opacity: 0.9;
      flex-shrink: 0; /* Prevents the gain from shrinking if the name is long */
    }
    .gain-positive {
      color: var(--gain-color);
    }
    .gain-negative {
      color: var(--loss-color);
    }
    .channel-details {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      overflow: hidden; /* Prevents long names from breaking layout */
    }
    .sub-counter-container {
      position: relative; /* Positioning context for the graph */
      display: flex;
      align-items: center;
    }
    .sparkline-graph {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      opacity: 0.5; /* Make graph less distracting */
      border: 1px solid var(--border-color);
      border-radius: 4px;
      background-color: rgba(0, 0, 0, 0.05);
    }
    /* Settings Panel Styles */
    .header-controls {
      position: relative; /* Needed for panel positioning */
    }
    .settings-panel {
      position: absolute;
      top: 100%;
      right: 0;
      background-color: var(--bg-color-light);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 12px 16px;
      z-index: 100;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      width: max-content;
    }
    .settings-panel h4 {
      margin-top: 0;
      margin-bottom: 8px;
      font-weight: 500;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 6px;
    }
    .setting-option {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
  `;
  document.head.appendChild(style);
}


/**
 * Initializes a counter to display the total number of channels being tracked.
 */
function initializeUI() {
  const totalCountElement = document.getElementById('total-channel-count');
  if (totalCountElement) {
    totalCountOdometer = new Odometer({ el: totalCountElement, value: 0, duration: 1000 });
  }

  // Hide the milestone section as it's been removed for performance.
  const milestoneSection = document.getElementById('milestone-section');
  if (milestoneSection) {
    milestoneSection.style.display = 'none';
  }
  initializeSearchBar();
  initializeThemeToggle();
  initializeSettingsPanel();
}

/**
 * Main application logic. Checks for updates to the channel list and rebuilds the UI if necessary.
 */
function startApp() {
  async function checkForChannelListUpdates() {
    try {
      const res = await fetch('channels.json');
      if (!res.ok) {
        container.innerHTML = '<p style="text-align: center; color: red;">Error: Could not load channels.json. Please ensure the file exists.</p>';
        return;
      }
      const newChannelIds = await res.json();

      // Compare the new list with the current one. If they differ, reload the dashboard.
      if (JSON.stringify(newChannelIds) !== JSON.stringify(currentChannelIds)) {
        console.log('Channel list has changed. Reloading dashboard...');
        // Clear old state from localStorage since the channel list is different
        localStorage.removeItem(LOCAL_STORAGE_KEY);
        currentChannelIds = newChannelIds;
        totalCountOdometer?.update(currentChannelIds.length);
        createChannels(currentChannelIds);
      }
    } catch (error) {
      console.error('Error fetching or parsing channels.json:', error);
    }
  }

  checkForChannelListUpdates(); // Initial load
  setInterval(checkForChannelListUpdates, 5000); // Check for updates every 5 seconds
}

initializeUI();
applyCustomStyles();
startApp();
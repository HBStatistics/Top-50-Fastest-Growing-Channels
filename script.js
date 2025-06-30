const API_KEY = 'AIzaSyBgELAGkvluwfu6CNKHNDTwq20_8lckcZU'; // IMPORTANT: Replace with a valid YouTube Data API key from Google Cloud Console.

const container = document.getElementById('channelList');
const odometerInstances = new Map();
const LOCAL_STORAGE_KEY = 'channelDashboardState';
let currentChannelIds = [];
let subCountUpdateInterval = null;
let totalCountOdometer = null;
let milestoneOdometer = null;
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
    // This API endpoint returns the count directly in the `subCount` property.
    return data.subCount || 0;
  } catch (error) {
    console.error(`Error fetching sub count for ${channelId}:`, error);
    return 0;
  }
}

/**
 * Extracts the dominant color from a channel's logo and applies it as a glow effect.
 * @param {HTMLElement} element The channel card element.
 * @param {string} imageUrl The URL of the channel's logo.
 */
function applyDominantColor(element, imageUrl) {
  const img = new Image();
  img.crossOrigin = 'Anonymous';
  // Use a CORS proxy to prevent security errors when accessing image data.
  // Public CORS proxies can be unreliable. Switching to a different one to resolve the error.
  // The format for thingproxy is https://thingproxy.freeboard.io/fetch/https://...
  const proxiedUrl = `https://thingproxy.freeboard.io/fetch/${imageUrl}`;
  img.src = proxiedUrl;

  img.addEventListener('load', () => {
    try {
      const [r, g, b] = colorThief.getColor(img);

      // Darken the color by a factor to ensure white text is always readable
      const darkenFactor = 0.6;
      const darkR = Math.floor(r * darkenFactor);
      const darkG = Math.floor(g * darkenFactor);
      const darkB = Math.floor(b * darkenFactor);

      // Apply the darkened color as the background
      element.style.backgroundColor = `rgb(${darkR}, ${darkG}, ${darkB})`;
      element.style.boxShadow = 'none'; // Remove shadow for a flat, modern look

      // Always use white text on the darkened background
      element.style.color = '#fff';
      element.style.setProperty('--odometer-text-color', '#fff');
    } catch (e) {
      console.error(`Could not get color from image: ${imageUrl}`, e);
    }
  });

  img.addEventListener('error', () => {
    console.error(`Failed to load image for color extraction: ${proxiedUrl}`);
  });
}

/**
 * Calculates the last passed milestone for a given subscriber count.
 * @param {number} subs The subscriber count.
 * @returns {number} The milestone value.
 */
function getMilestoneFor(subs) {
  if (subs < 1000000) { // Under 1M, milestones are every 100k
    return Math.floor(subs / 100000) * 100000;
  }
  if (subs < 10000000) { // Under 10M, milestones are every 1M
    return Math.floor(subs / 1000000) * 1000000;
  }
  // Over 10M, milestones are every 10M
  return Math.floor(subs / 10000000) * 10000000;
}

/**
 * Updates the milestone display in the header.
 * @param {object} channel The channel that hit the milestone.
 * @param {number} milestoneValue The value of the milestone.
 */
function updateMilestoneDisplay(channel, milestoneValue) {
  const section = document.getElementById('milestone-section');
  const avatar = document.getElementById('milestone-avatar');
  const handle = document.getElementById('milestone-handle');

  if (section && avatar && handle && milestoneOdometer) {
    avatar.src = channel.img;
    handle.textContent = channel.handle;
    milestoneOdometer.update(milestoneValue);
    section.style.visibility = 'visible';
  }
}

async function createChannels(channelIds) {
  // Display a loader while fetching initial data
  container.innerHTML = '<div class="loader"></div>';

  let channels;
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
  if (!channels) {
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
    });
  }

  // Sort channels by growth rate to maintain consistent ranking on refresh
  channels.sort((a, b) => b.gain - a.gain);

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

    div.innerHTML = `
      <div class="channel-rank">${rank}</div>
      <div class="channel-avatar-container">
        <img class="channel-avatar" src="${channel.img}" alt="${channel.name}">
        ${flagHtml}
      </div>
      <div class="channel-details">
        <div class="channel-name">${channel.handle}</div>
        <div id="subs-${channel.id}" class="odometer odometer-theme-default"></div>
      </div>
    `;
    container.appendChild(div);

    applyDominantColor(div, channel.img);

    // Manually initialize Odometer on the newly created element.
    // Store the instance so we can call its .update() method later.
    const odInstance = new Odometer({
      el: document.getElementById(`subs-${channel.id}`),
      value: channel.subs,
      duration: 2000, // Set animation speed to 2 seconds
    });
    odometerInstances.set(channel.id, odInstance);
  });

  // The odometers are already initialized with the correct counts.
  // Clear any existing interval before setting a new one.
  if (subCountUpdateInterval) {
    clearInterval(subCountUpdateInterval);
  }
  // Use a faster interval now that we are using the Mixerno API for frequent updates.
  subCountUpdateInterval = setInterval(() => updateCounts(channels), 2000); // Update every 2 seconds
}

async function updateCounts(channels) {
  // Store the current order of channel IDs before re-sorting
  const oldOrderIds = channels.map(c => c.id);

  // 1. Fetch fresh subscriber counts from Mixerno in parallel
  const allNewSubs = await Promise.all(
    channels.map(channel => fetchSubCount(channel.id))
  );

  // 2. Update channel data and DOM with new counts
  channels.forEach((channel, index) => {
    const newSubs = allNewSubs[index];
    if (newSubs > 0) { // Only update if the fetch was successful
      const oldSubs = channel.subs;

      // Check for milestone
      if (oldSubs > 0) {
        const oldMilestone = getMilestoneFor(oldSubs);
        const newMilestone = getMilestoneFor(newSubs);
        if (newMilestone > oldMilestone) {
          updateMilestoneDisplay(channel, newMilestone);
        }
      }

      if (oldSubs > 0) {
        channel.gain = newSubs - oldSubs;
      }
      channel.subs = newSubs;

      const odInstance = odometerInstances.get(channel.id);
      if (odInstance) {
        odInstance.update(newSubs);
      }
    }
  });

  // 3. Sort channels by the gain in the last interval to rank by growth rate
  channels.sort((a, b) => b.gain - a.gain);

  // 4. Re-order DOM, update ranks, and apply animations for overtakes
  channels.forEach((channel, newIndex) => {
    const element = document.getElementById(`channel-${channel.id}`);
    const oldIndex = oldOrderIds.findIndex(id => id === channel.id);

    element.querySelector('.channel-rank').textContent = (newIndex + 1).toString().padStart(2, '0');

    if (oldIndex !== -1 && newIndex < oldIndex) {
      element.classList.add('rank-up-animation');
      element.addEventListener('animationend', () => element.classList.remove('rank-up-animation'), { once: true });
    }

    container.appendChild(element); // This re-orders the element in the DOM
  });

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
 * Initializes a counter to display the total number of channels being tracked.
 */
function initializeUI() {
  const totalCountElement = document.getElementById('total-channel-count');
  if (totalCountElement) {
    totalCountOdometer = new Odometer({ el: totalCountElement, value: 0, duration: 1000 });
  }

  const milestoneValueElement = document.getElementById('milestone-value');
  if (milestoneValueElement) {
    milestoneOdometer = new Odometer({ el: milestoneValueElement, value: 0, duration: 2000 });
  }

  initializeSearchBar();
  initializeThemeToggle();
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
startApp();
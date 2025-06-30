const API_KEY = 'AIzaSyBgELAGkvluwfu6CNKHNDTwq20_8lckcZU'; // IMPORTANT: Replace with a valid YouTube Data API key from Google Cloud Console.

const channelIds = [
  'UCX6OQ3DkcsbYNE6H8uQQuVA', // MrBeast
  'UCZs0WwC0Dn_noiQE2BHSTKg', // Alejo Igoa
  'UCPuEAY09CtdTzFNWuqVZgDw', // Topper Guild
  'UCHdH2ijb9dtQRRH08u1jd7A', // Masters Of Prophecy
  'UCoJ5osZ535ar2kzHwQMnLsA', // Double Date
  'UCppHT7SZKKvar4Oc9J4oljQ', // Zee TV
  'UC2tsySbe9TNrI-xh2lximHA', // A4
  'UCCtALHup92q5xIFb7n9UXVg', // Toyota Gazoo Racing
  'UCvlE5gTbOvjiolFlEm-c_Ow', // Vlad and Niki
  'UCbp9MyKCTEww4CxEzc_Tp0Q', // Stokes Twins
  'UCq-Fj5jknLsUf-MWSy4_brA', // T-Series
  'UCiVs2pnGW5mLIc1jS2nxhjg', // 김프로KIMPRO
  'UCe6n0z9UbsxYCS8P83f84tw', // Sierra & Rhia FAM
];

const container = document.getElementById('channelList');
const odometerInstances = new Map();

/**
 * Fetches basic channel info (name, image) from the YouTube API.
 * @param {string[]} idArray An array of YouTube channel IDs.
 * @returns {Promise<object[]>} A promise that resolves to an array of channel data objects.
 */
async function fetchChannelsData(idArray) {
  const idString = idArray.join(',');
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${idString}&key=${API_KEY}`);
  const data = await res.json();

  if (!data.items || data.items.length === 0) {
    console.error(`Could not fetch channel data. Response:`, data);
    return [];
  }

  // Map the API response to our desired channel object structure, without sub counts.
  return data.items.map(item => ({
    id: item.id,
    name: item.snippet.title,
    img: item.snippet.thumbnails.default.url,
    country: item.snippet.country,
  }));
}

/**
 * Fetches the live, unabbreviated subscriber count from the Mixerno API.
 * @param {string} channelId A YouTube channel ID.
 * @returns {Promise<number>} A promise that resolves to the subscriber count.
 */
async function fetchSubCount(channelId) {
  try {
    // Use the Mixerno API for live, unabbreviated subscriber counts.
    const res = await fetch(`https://mixerno.space/api/youtube-channel-counter/user/${channelId}`);
    if (!res.ok) {
      console.error(`Failed to fetch sub count for ${channelId}. Status: ${res.status}`);
      return 0;
    }
    const data = await res.json();
    return data.subCount || 0;
  } catch (error) {
    console.error(`Error fetching sub count for ${channelId}:`, error);
    return 0;
  }
}

async function createChannels() {
  // Display a loader while fetching initial data
  container.innerHTML = '<div class="loader"></div>';

  // 1. Fetch static channel data (name, image) from YouTube API
  const channels = await fetchChannelsData(channelIds);

  // Handle cases where the API call failed completely
  if (channels.length === 0) {
      container.innerHTML = '<p style="text-align: center;">Failed to load channel data. Please check your API key and the console for errors.</p>';
      return;
  }

  // 2. Fetch initial subscriber counts from Mixerno API
  const initialSubCounts = await Promise.all(
    channels.map(channel => fetchSubCount(channel.id))
  );

  // 3. Combine the data into the final channel objects
  channels.forEach((channel, index) => {
    channel.subs = initialSubCounts[index] || 0;
    channel.gain = 0;
  });

  // Sort channels initially by subscriber count
  channels.sort((a, b) => b.subs - a.subs);

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
        <div class="channel-name">${channel.name}</div>
        <div id="subs-${channel.id}" class="odometer odometer-theme-default"></div>
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
  });

  // The odometers are already initialized with the correct counts.
  // The setInterval will handle all subsequent updates.
  setInterval(() => updateCounts(channels), 2000); // Update every 2 seconds
}

async function updateCounts(channels) {
  // Store the current order of channel IDs before re-sorting
  const oldOrderIds = channels.map(c => c.id);

  // 1. Fetch fresh subscriber counts in parallel
  const allNewSubs = await Promise.all(
    channels.map(channel => fetchSubCount(channel.id))
  );

  // 2. Update channel data and DOM with new counts
  channels.forEach((channel, index) => {
    const newSubs = allNewSubs[index];
    if (channel.subs > 0) {
      channel.gain = newSubs - channel.subs;
    }
    channel.subs = newSubs;
    const odInstance = odometerInstances.get(channel.id);
    if (odInstance) {
      odInstance.update(newSubs);
    }
  });

  // 3. Sort channels by the new subscriber count
  channels.sort((a, b) => b.subs - a.subs);

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
}

createChannels();

/**
 * Initializes a counter to display the total number of channels being tracked.
 */
function initializeTotalChannelCounter() {
  const totalCountElement = document.getElementById('total-channel-count');
  if (totalCountElement) {
    new Odometer({ el: totalCountElement, value: channelIds.length, duration: 1000 });
  }
}

initializeTotalChannelCounter();

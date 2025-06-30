const API_KEY = 'AIzaSyBgELAGkvluwfu6CNKHNDTwq20_8lckcZU'; // Replace with your API key

const channelIds = [
  'UCX6OQ3DkcsbYNE6H8uQQuVA', // MrBeast
  'UCzEfgHQvN3rOzP2U53LrIIQ', // Hokky@Happy (example)
  'UCjH4MsEzY9kMRv-REa1JDwg', // H2H INFOPRO
  'UCBUACi6IK1nE3vBZZVokewQ', // Masters Of Prophecy
  'UCcsqUW9D2zOzzJ7XYchqiHg', // Double Date
  'UCllzIrwN6jCbT3zQF7R9ouQ', // Raj Shamani
  'UCXk4P-LDdv2tppM1vslK2Jw', // JAWG
  'UCJgGc8pQO1lv04VXrBxBzlw', // Toyota Gazoo Racing
  'UCQYw2iD3ZbYpIMXbZtqR4og', // Anant Gupta
  'UC9CoOnJkIBMdeijd9qYoT_g', // Forever
];

const container = document.getElementById('channelList');

async function fetchChannelInfo(channelId) {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${API_KEY}`);
  const data = await res.json();

  // The API can return an error object or an empty items array if the channel is not found or the key is invalid.
  if (!data.items || data.items.length === 0) {
    console.error(`Could not fetch channel info for ID: ${channelId}. Response:`, data);
    return null; // Return null to indicate an error
  }

  const snippet = data.items[0].snippet;
  return {
    id: channelId,
    name: snippet.title,
    img: snippet.thumbnails.default.url,
    subs: 0,
    gain: 0,
  };
}

async function fetchSubCount(channelId) {
  try {
    // Corrected the URL to use the actual channelId
    const res = await fetch(`https://mixerno.space/api/youtube-channel-counter/user/${channelId}`);
    if (!res.ok) {
      console.error(`Failed to fetch sub count for ${channelId}. Status: ${res.status}`);
      return 0; // Return a default value on error
    }
    const data = await res.json();
    // The Mixerno API returns the count in data.user[0].count
    if (data.user && data.user.length > 0) {
      return data.user[0].count || 0;
    }
    return 0; // Return 0 if the structure is not as expected
  } catch (error) {
    console.error(`Error fetching sub count for ${channelId}:`, error);
    return 0; // Return a default value on network error
  }
}

async function createChannels() {
  // Display a loader while fetching initial data
  container.innerHTML = '<div class="loader"></div>';

  const channelsData = await Promise.all(channelIds.map(fetchChannelInfo));

  // Clear the loader
  container.innerHTML = '';

  // Filter out any channels that failed to load to prevent errors
  const channels = channelsData.filter(channel => channel !== null);

  channels.forEach(channel => {
    const div = document.createElement('div');
    div.className = 'channel';
    div.id = `channel-${channel.id}`;
    div.innerHTML = `
      <img src="${channel.img}" alt="${channel.name}">
      <div class="channel-details">
        <div class="channel-name">${channel.name}</div>
        <div id="subs-${channel.id}" class="odometer">0</div>
      </div>
    `;
    container.appendChild(div);
  });

  // Initial update
  updateCounts(channels);
  // Auto update every 2 seconds
  setInterval(() => updateCounts(channels), 2000);
}

async function updateCounts(channels) {
  // 1. Fetch new counts and calculate gain for each channel
  for (const channel of channels) {
    const newSubs = await fetchSubCount(channel.id);
    // Only calculate gain after the first data point is established
    if (channel.subs > 0) {
      channel.gain = newSubs - channel.subs;
    }
    channel.subs = newSubs;
    document.getElementById(`subs-${channel.id}`).innerHTML = newSubs;
  }

  // 2. Find the channel with the highest positive gain
  let fastestGainer = null;
  let maxGain = 0;
  for (const channel of channels) {
    if (channel.gain > maxGain) {
      maxGain = channel.gain;
      fastestGainer = channel;
    }
  }

  // 3. Update the visual indicator on each channel element
  for (const channel of channels) {
    const element = document.getElementById(`channel-${channel.id}`);
    element.classList.toggle('fastest-gainer', channel === fastestGainer);
  }
}

createChannels();
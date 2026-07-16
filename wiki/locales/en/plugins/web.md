# Web Search (beilu-web)

beilu-web enables the AI to search the internet and browse web pages. When the AI needs real-time information, reference material, or fact verification, it can initiate web requests via the `<search>` and `<browse>` tags.

## Search Feature

### AI-Initiated Search

The AI uses the `<search>` tag in its reply to initiate a search request. beilu-web parses the tag, performs the search, and injects the results into the next conversation turn.

### Search Results

Search results contain three fields:

| Field | Description |
|-------|-------------|
| title | Web page title |
| url | Web page URL |
| snippet | Content summary |

After receiving search results, the AI can choose to answer directly (if the summary information is sufficient) or use the `<browse>` tag to visit a specific page for more detailed content.

### Manual Search

In the beilu-web configuration panel, you can also manually enter search terms and view search results.

## Web Page Browsing

The AI uses the `<browse>` tag to access web page content at a specified URL. beilu-web crawls the page body and returns it to the AI.

### Crawl Capability Detection

beilu-web automatically detects the current environment's web crawling capabilities on startup:

- If Playwright browsers are installed, it can render JavaScript-heavy dynamic pages
- If not installed, it falls back to simple HTTP fetching (which may not retrieve SPA page content)

You can install Playwright browsers via `ensureBrowsers` to support crawling dynamic (JavaScript-rendered) pages.

## Security Mechanisms

Web requests are sent through the `safeFetch` secure fetching function, which includes:

- Timeout protection
- Response size limits
- Malicious URL filtering

## Use Cases

| Scenario | Description |
|----------|-------------|
| Querying real-time info | Weather, news, exchange rates, and other questions requiring the latest data |
| Technical documentation | AI looks up official documentation to answer technical questions |
| Fact checking | Verifying information the AI is uncertain about |
| Research compilation | Aggregating information from multiple sources |

## Configuration

Search engine and related settings can be adjusted in the beilu-web configuration panel. Web features require a network connection to function properly.

## Relationship with the Memory System

beilu-web's web search is also invoked by the [memory system](../memory/overview.md)'s P8 Preset. When the AI determines during a conversation that external information is needed, the P8 pipeline triggers a web search, and results are automatically integrated into the conversation context.

## Navigation

- [Plugin Overview](overview.md) -- Plugin system introduction
- [Screen Perception (beilu-eye)](eye.md) -- Another way to obtain information
- [Memory System Overview](../memory/overview.md) -- P8 web search Preset

using System.Text.Json;
using Windows.Media.Control;
using Windows.Storage.Streams;

internal sealed record Command(string Action);

internal static class Program
{
    private static GlobalSystemMediaTransportControlsSessionManager? manager;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private static void Write(object payload)
    {
        Console.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
        Console.Out.Flush();
    }

    public static async Task<int> Main()
    {
        try
        {
            manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            Write(new { type = "ready", message = "Connected to Windows Global System Media Transport Controls." });
        }
        catch (Exception ex)
        {
            Write(new { type = "error", message = Explain(ex) });
            return 2;
        }

        while (true)
        {
            var line = await Console.In.ReadLineAsync();
            if (line is null) break;
            Command? command;
            try { command = JsonSerializer.Deserialize<Command>(line, JsonOptions); }
            catch { Write(new { type = "error", message = "Invalid bridge command." }); continue; }
            if (command is null) continue;
            if (command.Action == "quit") break;
            try
            {
                var session = manager?.GetCurrentSession();
                if (session is null)
                {
                    if (command.Action == "snapshot") Write(new { type = "snapshot", data = (object?)null });
                    continue;
                }

                switch (command.Action)
                {
                    case "playPause": await session.TryTogglePlayPauseAsync(); break;
                    case "next": await session.TrySkipNextAsync(); break;
                    case "previous": await session.TrySkipPreviousAsync(); break;
                    case "snapshot": await WriteSnapshot(session); break;
                }
            }
            catch (Exception ex)
            {
                Write(new { type = "error", message = Explain(ex) });
            }
        }
        return 0;
    }

    private static async Task WriteSnapshot(GlobalSystemMediaTransportControlsSession session)
    {
        var properties = await session.TryGetMediaPropertiesAsync();
        var playback = session.GetPlaybackInfo();
        var timeline = session.GetTimelineProperties();
        string? artwork = null;
        string? artworkMimeType = null;
        try
        {
            if (properties.Thumbnail is not null)
            {
                using IRandomAccessStream stream = await properties.Thumbnail.OpenReadAsync();
                using var memory = new MemoryStream();
                await stream.AsStreamForRead().CopyToAsync(memory);
                if (memory.Length <= 900 * 1024) { artwork = Convert.ToBase64String(memory.ToArray()); artworkMimeType = stream.ContentType; }
            }
        }
        catch { /* Artwork is optional; metadata and controls remain available. */ }

        Write(new
        {
            type = "snapshot",
            data = new
            {
                title = properties.Title ?? "",
                artist = properties.Artist ?? "",
                album = properties.AlbumTitle ?? "",
                appId = session.SourceAppUserModelId ?? "",
                playbackStatus = playback.PlaybackStatus.ToString(),
                isPlaying = playback.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing,
                positionMs = Math.Max(0, timeline.Position.TotalMilliseconds),
                durationMs = Math.Max(0, timeline.EndTime.TotalMilliseconds),
                artworkBase64 = artwork,
                artworkMimeType
            }
        });
    }

    private static string Explain(Exception ex)
    {
        if (ex is UnauthorizedAccessException || ex.HResult == unchecked((int)0x80070005))
            return "Windows denied access to system media sessions. Desknotch may need a package identity with the globalMediaControl capability.";
        if (ex.HResult == unchecked((int)0x80040154))
            return "The Windows media-control runtime is unavailable on this device.";
        return $"{ex.GetType().Name}: {ex.Message}";
    }
}

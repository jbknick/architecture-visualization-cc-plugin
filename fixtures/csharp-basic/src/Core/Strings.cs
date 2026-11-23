namespace Acme.Core;

public static class Strings
{
    public static string Shout(string text)
    {
        return text.ToUpperInvariant() + "!";
    }
}

namespace Acme.Core;

public static class StringExtensions
{
    public static string Twice(this string text)
    {
        return text + text;
    }
}

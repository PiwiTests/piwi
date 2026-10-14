namespace SampleApp.Services;

public sealed record User(int Id, string Name);

/// <summary>The users the slow page asks for, one per id.</summary>
public sealed class UserDirectory
{
    public User Find(int id) => new(id, $"User {id}");
}

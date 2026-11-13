# Scale Service (vendor-supplied .NET 6 Web.API), packaged from the binary drop.
#
# The binaries are NOT in this repo. They come in through the `vendor` build
# context, which compose points at $SCALE_VENDOR_DIR (the folder the client sent).
#   docker compose build scale-api

# Stage 1: copy the drop and strip what must not end up in the image:
# the database files, debug symbols, IIS/Windows launchers, docs and every
# config file that carries credentials.
FROM busybox:1.37 AS drop
COPY --from=vendor . /drop
RUN cd /drop \
 && rm -rf DBi logs *.pdb *.exe web.config *.docx appsettings*.json Integration.dll.config \
 && test -f Web.API.dll

FROM mcr.microsoft.com/dotnet/aspnet:6.0
WORKDIR /app
COPY --from=drop /drop/ ./
# Secret-free settings. Credentials are supplied at runtime via env vars
# (ConnectionStrings__DefaultConnection, Jwt__Key) and the mounted
# Integration.dll.config.
COPY appsettings.json ./appsettings.json
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
# The 6.0 image has no non-root user built in; run as an unprivileged uid.
USER 1000:1000
ENTRYPOINT ["dotnet", "Web.API.dll"]

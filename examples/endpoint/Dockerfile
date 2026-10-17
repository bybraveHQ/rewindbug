FROM node:22-alpine
WORKDIR /app
COPY server.mjs viewer.html ./
RUN mkdir /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=7358 REWINDBUG_DIR=/data
VOLUME /data
EXPOSE 7358
USER node
CMD ["node", "server.mjs"]
